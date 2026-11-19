# wisprflow4agents: plan

Status: built and live-checked (`docs/live-check.md`); a tagged release remains.
Facts about the Wispr MCP are in `RESEARCH.md`; this file only decides what to build.

## Goals

1. A public Claude Code plugin. Nothing specific to one person's machines: no proxy
   setup, no personal config files, no background daemons. Works installed globally or per project.
2. After a one-time login per machine, the user can tell a session to **watch** one Wispr
   folder or the whole note list, and the session is told when a note appears or changes.
3. **The model never reads Wispr on its own.** It gets one tool, `wispr`, and nothing reads
   notes unless the user asked: a watch the user armed (typed, or asked for in a message the
   user typed or another Claude session relayed for them), a check of a scope that session
   watches, or a one-off check the user typed.

Not goals: writing to Wispr (the MCP is read-only: no folders, titles, summaries or filing),
dictation history (not exposed), anything on Discord.

## Shape: one mod, no MCP server entry, no daemon

Compared with an earlier daemon-based watcher plugin for a chat service, and read from the
plugin-authoring types shipped with Claude Code 2.1.322 (`types/claude-code.d.ts`, cited as T:line).

| piece | the daemon-based design did | wisprflow4agents does | why |
|---|---|---|---|
| polling | one `wsdaemon.py` per watching session, 120 s | a timer inside the session (`$.clock.every`), re-armed at `session.start` from `$.store` | no process to clean up, survives restart through the store, no extra tooling |
| waking the session | `notify-session.py` writes NDJSON into the session's private socket | `$.prompt.submit` (T:3111: "a turn of its own, once the session is idle") plus `$.ui.toast` | the socket wire is an undocumented internal; `prompt.submit` is the public mod API (the daemon-based design itself used it for its sign-in alert) |
| reaching the service | its own scripts | `$.http.fetch` speaking MCP JSON-RPC to `https://api.wisprflow.ai/connect/mcp` | goes through the host, so the user's `HTTPS_PROXY`/`NO_PROXY` apply, if any (to verify) |
| keeping the model out | write gates only; the main skill was model-invocable | no `mcpServers`, no `.mcp.json`; one mod tool (`wispr`) that reads only what its session watches; command skills that answer only a run the person typed (login excepted: it only makes a link) | see next section |
| call volume | 5 daemons ≈ 25k API calls/day (measured) | one poll per (machine, account, scope) per interval, shared through `$.store` | that design's own lesson |

The mod API "is early access and moves between releases" (plugin-authoring reference). The
manifest has no field for a minimum Claude Code version, so the README says "tested on 2.1.322"
instead.

## Keeping the model out (goal 3)

- **No MCP server in the manifest.** T:2873: a listed server joins at session start and its
  tools are visible; only a `tool.check` refusal holds them back, and under
  `allowManagedHooksOnly` a user plugin's hooks do not load while its server still connects
  (T:2877), so that gate fails open. Not listing it means there is no Wispr MCP tool.
- **The plugin is the only MCP client**, through `$.http.fetch`, and it calls Wispr from
  three places: a command the user typed, the poll timer of an armed watch, and the `wispr`
  tool under the rule below.
- **Typed commands.** Each is a plugin skill answered at `skill.prompt`, which carries no origin.
  `logout`, `watch`, `unwatch`, `watches` and `check` set `disable-model-invocation: true` and
  answer only with a permit left by `prompt.submit` for a typed run of that skill (`e.command`,
  origin `composer` or `bridge`), raised before the skill is rendered (measured). One permit per
  skill, the latest typed run's; it lasts 30 s and is revoked when a hook below drops the
  prompt (`hooks/permit.ts`). A model-invoked run (a backstop) is refused with a pointer to the tool.
- **The model's tool.** Model-invoked skills cannot serve the model: a second Skill call of one
  skill in a session answers "already loaded" and never reaches the mod (measured), and a
  request relayed by another Claude session carries no typed-origin permit. So the model gets one
  mod tool, `$.tool.register({ name: 'wispr' })`, schema in the prompt (`isDeferred: false`),
  answered at `tool.call` for the name the engine returns. Verbs: `watch`, `unwatch`, `watches`,
  `folders` (names only), `check`; never `logout`. Its description says to call it only for a
  request the user made, typed or relayed. **Rule:** reading is limited to what the session
  watches. `check` (with or without `--transcript`) reads only a scope the session has an armed
  watch on (no scope: each watched scope); a session with no watch reads nothing. Arming is
  open, since the user asked for it. A typed `check` keeps reading any folder.
- **`login` is the exception:** model-invocable so "log me in to Wispr" gets the link. It
  only makes a link; it reads no notes.
- **What reaches the model:** the text of a watch alert (a prompt from origin `plugin`), of a
  check the user typed, and of its `wispr` tool calls. It can fetch more only through the tool,
  so only what its session watches, plus folder names.
- If the user separately adds the Wispr MCP with `claude mcp add`, its tools are visible;
  that is outside the plugin and the README says so.

## Commands

All are plugin skills typed as `/wisprflow4agents:<verb>` (`skills/<verb>/SKILL.md`; the mod computes each answer at `skill.prompt`, and the SKILL.md body is only a fallback for when the mod is not loaded). The earlier `/wispr-<verb>` mod commands are gone: mod commands are global and cannot be namespaced (docs/spike.md).

| command | does |
|---|---|
| `login` | OAuth auth code + PKCE (see Login). Ends with one `list_folders` call as proof. |
| `logout` | deletes this machine's tokens, client registration and cached notes. |
| `watch [folder name \| all] [--every 5m] [--toast]` | arms a watch for this session. `all` is the whole meeting and note list. |
| `unwatch [name \| all]` | removes this session's watches. |
| `watches` | lists this session's watches, last poll, last change, errors. |
| `check [folder name \| all] [--since 1d] [--transcript]` | one-off read now: what is new or changed, submitted to the model as one prompt; `--transcript` adds each meeting's summary, full notes and full transcript (ranged `get_meeting` reads stitched together, 400,000 characters per run, then a line saying where it cut). |

The `wispr` tool runs the same verbs (and `folders`) from the same code, under the rule above.

## Watch

- Stored in `$.store` under the project root (`$.session.root()`) and the session id, so
  a resumed session gets its watches back and another project's sessions do not see them.
- Poll, per scope:
  - `all`: `search_meetings` with no query (newest modified first) and
    `search_scratchpad_notes` with no query; page until an item's `modified_at` is older than
    the last poll.
  - a folder: every folder's membership in one shared read (`list_folders`, then
    `list_folder_meetings` per folder), cached under `poll:folders`, so every folder watch on
    the machine shares it. Filing does not bump `modified_at` (measured), so a folder watch
    keeps each member's folder set and diffs it: `added to W`, `removed from W`, and for a
    meeting in W (or just out of it) `added to X` / `removed from Y`; a removal and an addition
    in one poll read `moved A -> B`. A newcomer's earlier folders are not known to that watch.
  - Wispr has no status field on a meeting (schema/tools.json), so there is none to watch.
- Event = a new id, or a known id whose `modified_at` moved (rename, transcript ready,
  speaker rename all moved it; filing into a folder did not).
- On an event: a toast always; unless `--toast` is given, also one `$.prompt.submit` naming the
  notes (title, time, folder, a short excerpt, share link). Events of one tick from all of a
  session's watches merge into one line per meeting id (folder changes and a content change
  together). Edge-triggered: nothing on a quiet poll, never a timed prompt.
- After a restart the first poll diffs against the baseline kept in the store, so what changed
  while the session was down is reported. Only arming (or a new login) starts a fresh baseline.
- A band above the prompt (`ui.render` on `AbovePrompt`) while the session has a watch:
  `Wispr ◉ <names, three then +N> · polled 2m ago · <notes known> notes · <unread> new`, or the
  error (`login needed`) in place of the counts. Unread resets when a notice or check result
  is delivered. Redrawn after each tick and on arm and unarm; it reads only the session's
  watches, no extra calls.
- Sharing between sessions: the poll result is cached in `$.store` per (account, scope) with
  its time; a session whose interval is due first checks the cache and only calls Wispr if
  the cached result is older than its interval. N sessions watching `all` cost one poll.
- Default interval 5 min (288 calls/day per scope, a few more when paging). Minimum 1 min.
- Wispr down, 401, network error: the watch shows the error in `watches` and toasts once per
  outage; it never submits a prompt for an error, except "login needed" once.

## Login

- Auth server `https://mcp-auth.wisprflow.com`, dynamic client registration once per
  machine (public client, `authorization_code` + `refresh_token`, redirect
  `http://localhost:33418/callback`).
- `login` stores a pending login `{ url, verifier, state, until: now + 15 min }`; a run while
  one is pending reuses it, so a second session or run never kills a link in use.
- Two finishes, both armed, first wins:
  1. Loopback (RFC 8252): one short-lived listener on `127.0.0.1:33418` through
     `$.process.spawn` (`python3`, else `node`, else none). It answers one `/callback` with the
     pending `state`, prints the query and exits; it exits at `until` too. It runs in `HOME`, with
     `python3 -I` and no `NODE_OPTIONS`, so no project file is imported. The port is the lock: a
     session spawns at most one listener per login attempt; one that finds the port in use only
     reads the store until the login finishes, changes or expires (a runtime that fails for any
     other reason gives way to the next). If the listener's session closes first, the paste path
     still works and a new login run starts a listener. A listener is killed when the pending login
     changes or goes (finished by any path, or logout), and the module's unload kills it with its
     session. Address-in-use counts as another listener only when a connect to the port succeeds;
     refused means a closed connection (TIME_WAIT) still holds the port, and the listener prints
     `waiting` and retries every 0.5 s until `until`.
  1a. Browser on another machine: `WISPRFLOW4AGENTS_BROWSER_SSH`, else the userConfig
     field `browser_ssh_host` (comma-separated ssh hosts). The session whose listener printed
     anything (`waiting` or `listening`) runs `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=10
     -o ControlMaster=no -o ControlPath=none -R 33418:127.0.0.1:33418 -v <host>` per host in turn
     (15 s cap each) until stderr shows `remote forward success for: listen 33418`; `-v` is there
     only for that line. The forward is killed when the listener ends. The login hook waits up to
     7 s (hook budget 10 s) to say which path is armed; a later outcome comes as a toast.
  2. Paste: a typed prompt holding the callback URL finishes the login in `prompt.submit`; the
     model reads the prompt with the code replaced by `REDACTED` and one context line with the
     result. A typed command holding it is dropped with the result instead (a command's line
     takes no rewrite).
  Paste works on a desktop, over ssh, and from a phone through Remote Control.
- Device code flow: not usable, Wispr's login does not finish it (RESEARCH.md).
- Tokens: access 72 h, refresh token rotates on every refresh. Refresh is done lazily before a
  call. Every session on a machine shares one token, so refresh is serialized: a session
  takes a lock entry in `$.store` with an expiry, refreshes, writes the new pair, releases;
  others wait and re-read. Without this, two sessions refreshing at once would spend the same
  refresh token twice.
- Where tokens live: to decide (see Open). `$.store` is a plain JSON file under the user's
  Claude config dir.

## Network

Nothing proxy-specific in the plugin. `$.http.fetch` goes "through the host", which is
expected to honour the user's `HTTPS_PROXY` and `NO_PROXY` like the rest of Claude Code.
README troubleshooting: a network that blocks `*.wisprflow.ai` direct needs it routed via
its proxy; `mcp-auth.wisprflow.com` is a different domain and may be reachable when the
API is not.

## Repository layout

    .claude-plugin/plugin.json     name, version, description, license, userConfig
    hooks/register.tsx             the mod: skill answers, the wispr tool, timer, band, toasts, prompt.submit, login finish
    hooks/login.ts                 loopback listener scripts, callback parsing and redaction (pure)
    hooks/wispr.ts                 MCP JSON-RPC over $.http.fetch, OAuth, token lock
    hooks/watch.ts                 diff logic (pure: old snapshot + new page -> events)
    hooks/*.test.ts                tests for wispr.ts and watch.ts
    README.md                      install, login, commands, what the model can and cannot see, troubleshooting
    RESEARCH.md, schema/          kept as is
    docs/research/probe/           research scripts (moved from probe/)
    skills/wisprflow4agents/       the model-facing pointer skill (the wispr tool and its rule)
    skills/<verb>/                 login, logout, watch, unwatch, watches, check (bodies are fallbacks)

## Steps, each with its check

1. Scaffold the mod and the manifest; `/wisprflow4agents:watches` prints "no watches".
   Check: the command runs in a fresh session; the model's tool list has no Wispr MCP tool.
2. `wispr.ts`: MCP over `$.http.fetch`, login (paste flow), refresh with the lock.
   Check: login on a host behind a proxy and on one without; a forced expiry
   refreshes; two sessions refreshing at once both end with a working token.
3. `watch.ts`: diff for `all` and folder scopes. Check: unit tests from recorded
   responses (new id, moved `modified_at`, folder filing, paging stop).
4. Timer, shared cache, toast and `prompt.submit`. Check: arm a watch on the `test` folder,
   file a meeting into it in the app, the session wakes within one interval; a quiet poll
   wakes nothing; two sessions watching `all` cause one Wispr call per interval.
5. Origin gate. Check: a `prompt.submit` from another plugin or a model turn cannot run a
   command.
6. README and a tagged release; install from the GitHub marketplace into a clean HOME, globally
   and per project.

## Design decisions

1. **Slash commands for the person, one tool for the model.** The model reaches Wispr only
   through `wispr`, and reads only what its session watches. It never tells the user to type a
   command for something they already asked for.
2. **Mod-only**: everything through the mod API, state in `$.store`. A file
   only when unavoidable (a log, a lock), and then only under `~/.wisprflow4agents/`, capped. One exception: the login
   listener process, which never outlives its login and never runs twice.
3. **No pane.** One band above the prompt, only in a session with a watch.
4. **Commands are `/wisprflow4agents:<verb>`**, and a plain-language request
   to sign in yields the link.
