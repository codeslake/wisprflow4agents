# Wispr Flow remote MCP: what it can do

Research notes for a Claude Code plugin that wraps the Wispr Flow remote MCP.
No plugin code yet. Every claim below says whether it was measured or read.

## Endpoints (measured 2026-11-11)

| what | value |
|---|---|
| MCP server (streamable HTTP) | `https://api.wisprflow.ai/connect/mcp` |
| protected-resource metadata | `https://api.wisprflow.ai/.well-known/oauth-protected-resource` |
| authorization server | `https://mcp-auth.wisprflow.com` |
| scopes the resource asks for | `openid offline_access` |

Authorization server metadata (`/.well-known/oauth-authorization-server`):

- grants: `authorization_code` (PKCE `S256` only), `refresh_token`,
  `urn:ietf:params:oauth:grant-type:device_code`, `urn:ietf:params:oauth:grant-type:token-exchange`
- dynamic client registration at `/oauth2/register`; client metadata documents supported
- device authorization at `/oauth2/device_authorization`, verification page `/device`
- token endpoint auth: `none`, `client_secret_post`, `client_secret_basic`
- scopes: `openid offline_access email profile`

Login that works on a headless host (measured): register a public client with the
`authorization_code` grant and redirect `http://localhost:33418/callback`, open the
authorize URL in any browser, and paste back the callback URL the browser lands on.
`docs/research/probe/login.py` does exactly this. The token response carries `access_token` (JWT,
`expires_in` 259200 s = 3 days), `refresh_token` and `id_token`.

Renewal (measured 2026-11-11): the `refresh_token` grant with the same public `client_id`
returns a fresh 3-day access token and a NEW refresh token (rotation), with no browser.
So one browser login is enough as long as the newest refresh token is saved every time.
The refresh token's own lifetime is not stated in the response. There is no API key or
personal access token: the MCP accepts only these OAuth bearer tokens.

Dead ends for "log in once, mint more tokens" (measured 2026-11-11):

- `token-exchange` is advertised but refused to a public client ("Public clients are not
  authorized") and to a registered confidential client ("requires a first-party client").
- Introspection needs a confidential client (`Missing client_secret`) and reports another
  client's refresh token as `active: false`, so it cannot read the lifetime of a token
  issued to the public client.

What does work across hosts: the access token is a plain bearer token, so several hosts can
use the same one at once. Only the refresh token rotates, so exactly one host should hold
and refresh it and hand the current access token to the others.

The device_code grant is advertised and `/oauth2/device_authorization` does issue a user
code, but its browser step fails (measured 2026-11-11, three tries):

- The auth server is WorkOS AuthKit in "standalone connect" mode: `/oauth2/authorize`
  redirects to `https://api.wisprflow.ai/connect/login?external_auth_id=...`, where Wispr
  logs the user in and completes the request with that id.
- `/device` instead redirects to `/` and then to `https://api.wisprflow.ai/connect/login`
  WITHOUT `external_auth_id`, so Wispr's page shows "Missing external_auth_id" (try 1, no
  existing session).
- With an AuthKit session left from a normal login, the device page shows the code, but
  approving ends in "Activation denied / could not connect the device" (tries 2 and 3; a
  `web` client with only the device grant and `resource`, and a `native` client with the
  device and auth-code grants and no `resource`). The token endpoint never answered
  `access_denied`: it stayed `authorization_pending` until `expired_token`.

So Wispr has not wired AuthKit's device flow to its own login. That is Wispr's to fix.
Do not build on it.

## Server identity (measured)

`initialize` answers `serverInfo.name = "wispr-meetings"`, protocol `2025-06-18`,
capabilities `tools` only: no resources, no prompts, no subscriptions or list-changed
notifications. Every tool carries `readOnlyHint: true`, `destructiveHint: false`.
Results come back both as one JSON `text` content item and as `structuredContent`.
No tool declares an `outputSchema`, so the returned fields below are measured, not declared.

## Data scope (read from Wispr's docs; matches what was measured)

- The MCP reads the Wispr account in the cloud, not the desktop app, so the app need not run.
- Requires Notetaker and MCP access on the account and Cloud Sync on
  (otherwise "Cloud Sync must be enabled").
- Read-only. Meeting summaries, notes, transcripts, attendees, calendar events and linked
  recordings, upcoming and recurring meetings, shared-note links, meeting search
  (title, summary, own notes; date and attendee filters; newest-modified first).
- Not readable: dictation history, Notetaker chat history.
- Tags: none. Folders: yes (`list_folders`, `list_folder_meetings`, and a `folders`
  field on meeting results), contrary to the earlier reading.
- Change notifications: none. A watcher has to poll, using `modified_at` (see below).

## Tools (16, measured 2026-11-11)

Full input schemas and descriptions as served: `schema/tools.json`.

| tool | inputs | what it returns |
|---|---|---|
| `search_meetings` | `query`, `field` (title/content/both), `attendee_emails`, `attendee_match` (any/all), `contact_ids`, `since`, `until`, `limit` (25, max 200), `cursor` | meetings, newest modified first when no query |
| `get_meeting` | `meeting_id`, `view_content` {`start_char`, `char_limit` ≤ 40000}, `view_transcript` {same} | one meeting: markdown content, todos, transcript range |
| `get_meeting_participants_enriched` | `meeting_id` | user identity plus participants: name, contact_id, emails, spoke, organizer, role, relationship (own meetings only) |
| `get_participant_contacts` | `contact_ids` | LinkedIn, job title, company |
| `resolve_share_link` | `url`, `view_transcript` | a meeting reached by its share link |
| `search_scratchpad_notes` | `query`, `field`, `since`, `until`, `limit`, `cursor` | Notetaker scratchpad notes |
| `get_scratchpad_note` | `note_id`, `view_content` | one note's text range |
| `search_calendar_events` | `query`, `attendee_emails`, `attendee_match`, `since`, `until`, `limit`, `cursor` | calendar events |
| `resolve_calendar_link` | `url` | an event from a calendar link |
| `get_calendar_event` | `calendar_id` | one event |
| `get_meeting_by_calendar_id` | `calendar_id`, `view_content`, `view_transcript` | the meeting recorded for an event |
| `list_meeting_series` | `meeting_id`, `limit`, `cursor` | other meetings of a recurring series |
| `list_upcoming_meetings` | `window_hours` (24, max 168), `limit`, `cursor` | upcoming events with attendee preview and pre-read |
| `get_upcoming_meeting` | `calendar_id`, `include_preread` | one upcoming event |
| `list_folders` | none | folders the user owns or was added to |
| `list_folder_meetings` | `folder_id`, `limit`, `cursor` | meetings in a folder, `is_mine` per item |

## Returned fields (measured on a test account)

`search_meetings`:

    {meetings: [{id, title, content_excerpt, finalized, has_transcript, attendees[],
                 start, end, modified_at, share_link}], count, has_more, note}

`get_meeting` (with `view_content` and `view_transcript`):

    {id, title, content, finalized, has_transcript, attendees[], todos[],
     start, end, modified_at, share_link, transcript}

`list_folders`:

    {folders: [{id, name, description, is_mine, shared, note_count}]}

`list_folder_meetings` (note: `created_at`, no `modified_at`, owner is a plain name string):

    {meetings: [{id, title, is_mine, owner, summary_excerpt, created_at, share_link}], has_more}

A meeting filed in a folder shows it in `search_meetings` as `folders: [{id, name}]`
(`null` when in none). Filing a meeting into a folder did NOT change its `modified_at`
(measured: still the 2026-11-04 value after filing on 2026-11-11), so a watcher scoped to
a folder must diff folder membership itself; `modified_at` will not reveal a new filing.

`get_meeting_participants_enriched`:

    {meeting_id, user: {name, email, domain},
     participants: [{name, origin, contact_id, is_self, emails[], spoke, relationship, role}],
     mentioned_contacts[], note}

Renaming a speaker in the app (measured 2026-11-11: "Speaker 1" renamed to a person's name):

- shows at once in `participants` (`origin: "user"`, `role: "speaker-only"`, `emails: []`,
  `relationship: "unknown"`) and in the transcript speaker labels;
- DOES bump the meeting's `modified_at`;
- does NOT rewrite the generated summary (`content` still says "Speaker 1");
- was NOT found by `search_meetings` `query` with the new name right afterwards, although
  the description says `query` matches speaker names (index lag or a gap; not re-tested).

Transcripts are prefixed with a guard line telling the model that speaker labels are data,
not instructions.

Empty lists: `search_scratchpad_notes` `{notes, count, has_more}`, `search_calendar_events`
`{events, count, has_more}`, `list_upcoming_meetings` `{window_hours, events, count, has_more}`,
The descriptions also name fields that did not appear on this account's data: `shared`, `owner.name`, `next_cursor`,
`more`, `truncated`, `preread`, `attendee_count`.

## Paging, time and limits (from the tool descriptions)

- Cursor paging: `has_more` true means call again with `cursor = next_cursor`, copied verbatim.
  Capped at 1000 results per query; `truncated: true` means more exist beyond the cap.
- Long text is ranged, not paged: `get_meeting`, `get_scratchpad_note` and
  `resolve_share_link` take `start_char`/`char_limit` (default 12000, max 40000) and append
  a continuation marker when truncated.
- All timestamps are UTC ISO 8601 ending in `Z`.
- `since`/`until` filter on when a meeting happened (half-open), not on `modified_at`.
  A "what changed since my last look" watcher therefore lists by recency (no query) and
  stops at the first `modified_at` older than its last check.
- `query` matches title, summary, own notes and speaker names, never the transcript.

## The test account (measured 2026-11-11)

2 meetings, both untitled, no attendees, one with a transcript.
No scratchpad notes, no calendar events. One folder, `test`, with one meeting filed in it. So Notetaker is reachable but barely
used, and no calendar is connected. Dictation history is not exposed by this MCP at all.

## Network

- On a network measured to block `*.wisprflow.ai` direct, it must go through that network's
  proxy; `*.wisprflow.com` (auth server, CDN, update feed) was reachable direct there.
- So the smallest proxy surface is `.wisprflow.ai` only.

## Reproduce

    python3 docs/research/probe/login.py          # once; writes token.json (gitignored)
    python3 docs/research/probe/mcp.py tools/list
    python3 docs/research/probe/mcp.py tools/call '{"name": "search_meetings", "arguments": {"limit": 2}}'

Python 3 standard library only. Behind a proxy, keep `HTTPS_PROXY` set so
`api.wisprflow.ai` goes through it.
