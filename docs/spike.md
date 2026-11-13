# Spike: the mod API, measured

Claude Code 2.1.322, Linux. The spike was a mod named `wisprflow4agents` with
temporary commands (`/spike-env`, `/spike-fetch`, `/spike-store`, `/spike-lock`, `/spike-fs`,
`/spike-cmd`, `/spike-ctx`, `/spike-runcmd`, `/spike-submit`, `/spike-arm`, `/spike-disarm`,
`/spike-hammer`). Each command answered `{ text }` and appended one JSON line (instance id,
session id, result) to a log file the run read back. It ran in test sessions started with
`claude --plugin-dir <plugin dir> --settings '{"remoteControlAtStartup":false}'` in tmux, driven
with `send-keys` and read with `capture-pane`, the transcript JSONL and `--debug-file`.
Two sessions (A, B) ran at once for Q2. A one-file helper plugin `spike-caller` was loaded
beside B to see a command run by another plugin. The spike code was replaced by the scaffold
(`hooks/register.tsx`); each answer below names the command and what it called.

## Q1. `$.http.fetch` through a proxy; SSE bodies

Ran:

```ts
await $.http.fetch('https://api.wisprflow.ai/connect/mcp', { method: 'POST', headers: {
  Authorization: 'Bearer x', 'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { ... } }) })
```

Observed: `status 401`, `content-type application/json`, body `{"error":"invalid_token"}`,
958 ms. The same request from curl on that host: through the proxy, 401 with the same JSON
body; with `--noproxy '*'`, no bytes after 20 s (timeout). Direct access is blocked there, so
the 401 came through the proxy. The debug log names the call:
`$.http.fetch (wisprflow4agents): 401 in 958ms, 25 chars`.

A control session started with the proxy variables unset or pointed at a dead port answered
401 the same way. That run does not count: the test host's own setup puts an HTTPS proxy back into
the engine's environment at start (the debug log shows `HTTPS_PROXY` set to a local proxy port
in the MCP server environment it builds), so that session still went through a proxy. In every
session the engine's effective proxy was that host-injected one; a plain inherited
`HTTPS_PROXY` alone was never isolated. The engine's proxy handling is shown by the debug lines
`Cleared proxy agent cache`.

SSE: a local server sent three `text/event-stream` events one second apart and then closed.
`$.http.fetch('http://127.0.0.1:38917/')` resolved after 3002 ms with `status 200`,
`content-type text/event-stream`, and all three events in `text` (93 chars). The body comes back
whole, but only once the server closes the stream. A stream that stays open holds the call
until its timeout. The MCP spec has the server close a POST's SSE stream after its JSON-RPC
answer; that Wispr does so, read through `$.http.fetch`, is not measured here.

**Answer:** it goes through the host's proxy (Wispr's 401 JSON, not a block page or a timeout),
and an SSE body comes back whole in `text` once the server ends it.

## Q2. `$.store` across sessions, and a lock

Ran: `/spike-store set probe SPIKE-STORE-9917`, then searched `~/.claude` for the value.

- **File:** `~/.claude/plugins/store/wisprflow4agents_inline-<hash>.json`, mode `600`, plain
  pretty-printed JSON of every key. `_inline` is the `--plugin-dir` load. Not measured: whether
  an install from the skills folder or a marketplace uses the same file.
- **B reads A's set without a reload:** A `set x a1`; B `get x` returned `"a1"` right away.
- **No lost update when sequential:** B `set y b1`, then A `set x a2`; the file then held
  `probe`, `x: a2`, `y: b1`, and B `get y` returned `"b1"`.
- **No lost update when concurrent:** `/spike-hammer keys` in A and B, both started by a timer
  on the same 10 s boundary, each `await $.store.set` of 400 new keys in a loop. The first to
  finish (352 ms) saw 578 of the 800 keys (so the runs overlapped); the second saw all 800.
  Each session wrote 400 of its own and none were lost. Reads come from disk and each set merges
  into what is on disk.
- **A lease in `$.store`:** `/spike-hammer lease` in A and B on the same boundary, three runs.
  Each read `lease`, wrote `{ owner, until: now + 30 s }` if it was absent or expired, slept
  300 ms and read it back. In all three runs both saw no lease and both wrote, and on the read
  back both agreed on one owner (the last writer). Exactly one session counted itself the winner
  each time. That makes it a lease, not a mutex: there is no compare-and-set, so the winner is
  only certain if every contender writes inside the settle window.
- **Atomic primitives:** `$.store` has none (`get`, `set`, `delete`, `keys`). `$.fs` has no
  exclusive create, and `$.fs.write` rewrites in place (inode unchanged across two writes), so
  it is not atomic either. `mkdir` through `$.process.run` is atomic: three in parallel from one
  session returned exit codes `[0, 1, 1]`. Across sessions, A `mkdir` returned 0, B `mkdir`
  of the same path returned 1 (`File exists`), and after A's `rmdir` B got 0.

**Recommendation** (the design rule: everything through the mod API, state in `$.store`):

1. Store only (no files, no processes), and lock-free on the hard path. Before refreshing,
   re-read the token pair from `$.store`. If its refresh token differs from the one in hand,
   another session already rotated it, so use the stored pair. On `invalid_grant`, re-read
   `$.store` once more and use a pair that changed; only an unchanged pair means `LoginNeeded`.
2. Keep refreshes rare with a store lease: write `{ owner, until: now + 30 s }` when it is free,
   re-read after about 300 ms, and refresh only if the read-back owner is this session. The
   others wait out the lease and re-read the pair.
3. Fallback, only if (1) and (2) prove insufficient: `mkdir ~/.wisprflow4agents/refresh.lock`
   through `$.process.run` (measured atomic), with a stale timeout from the directory's
   `$.fs.stat().mtimeMs`. It uses a helper process and a file, so it goes against the design
   rule.

Not measured, and it decides how safe (1) is: whether Wispr revokes the whole token family when
a rotated refresh token is used again (OAuth reuse detection). If it does, a losing concurrent
refresh also kills the winner's new pair, and only the lease in (2) keeps that rare. Do not
probe this on a real account casually: a positive answer logs it out.

## Q3. Command names, model access, `e.origin.kind`

- **Name:** `$.command.register({ name: 'spike-cmd' })` is typed as `/spike-cmd`. The
  typeahead for `/spike-c` listed `/spike-cmd` and `/spike-ctx` with their descriptions.
  `/wisprflow4agents:spike-cmd` answered `Unknown command`. Names are global, not namespaced.
- **Built-in names are refused:** `claude plugin validate` on a variant registering `login`:
  `"/login" is a name Claude Code ships: $.command.register refuses it and the hook that calls
  it is skipped`. So mod commands cannot be named `login` or `logout`. Recommendation: prefix
  every command, `/wispr-login`, `/wispr-logout`, `/wispr-watch`, `/wispr-unwatch`,
  `/wispr-watches`, `/wispr-check`. A mod command cannot be spelled `/wisprflow4agents:*` either
  (the plugin later moved to plugin skills, which are namespaced; see below).
- **The model:** asked whether `spike-cmd` was listed anywhere (skills, tools, system prompt), it
  said no. Asked to run it, it called `Skill(spike-cmd)` and got
  `spike-cmd is a built-in CLI command, not a skill. Ask the user to run /spike-cmd themselves`.
  The model cannot see or run it.
- **`e.origin`:** typed: `{"kind":"composer"}`. Run by another plugin's `$.command.run`
  (from `spike-caller`'s timer): `{"kind":"plugin","name":"spike-caller"}`. A plugin's own
  `$.command.run` of its own command, from a timer, is not served by its own hook: the run
  printed `wisprflow4agents registered /spike-cmd but no command.run hook answered it`.
  `$.command.run` called from inside a `command.run` hook, awaited or not, is refused:
  `command.run: called from a command.run hook, it would wait on the turn this hook is holding`.
  Remote Control: not measured (these sessions run with Remote Control off). The types give
  `{ kind: 'bridge' }` for "the user's message through the Remote Control bridge".

**Answer:** `/x`, the person only; origin `composer` typed, `plugin` (with `name`) from another
plugin, `bridge` for Remote Control per the types. A guard allowing `composer` and `bridge`
refuses everything else.

## Q4. `{ text }` reaching the model; `$.prompt.submit` from `command.run`

- `/spike-cmd` answered `{ text }` holding `SPIKE-TEXT-7731`. The next API request (the
  `api-request-blob` rows of the transcript) carried it as
  `<local-command-stdout>wisprflow4agents+<other plugin>: {...SPIKE-TEXT-7731...}</local-command-stdout>`.
  Asked twice whether it could see `SPIKE-TEXT-7731`, the model said no both times. A third
  session ran `/wispr-watches` (text `No watches.`) and asked the model to quote what the last
  command printed: `CANNOT SEE`, while that request blob again held
  `<local-command-stdout>...No watches.</local-command-stdout>`. Unresolved: the stored
  request carries the text and the model says it cannot see it. Possible causes not separated:
  a hook of another plugin on this host rewriting the request after the blob is stored, or the
  model discounting local command output. Either way `text` must be treated as not private
  from the model (it is in the request as stored), and not as a way to make the model read
  something.
- `/spike-ctx` answered `{ text, context: ['SPIKE-CONTEXT-4410: ...'] }`. The model quoted
  `SPIKE-CONTEXT-4410` and called it a hidden note: it is stored as a hidden user message
  (`isMeta: true`).
- `await $.prompt.submit(...)` inside `command.run`: refused, `prompt.submit: called from a
  command.run hook, it would wait on the turn this hook is holding; submit from a later event
  (turn.complete)`. Un-awaited (`void`): refused the same way. `$.clock.after(0, submit)`:
  refused the same way (it fired before the hook settled). `$.clock.after(2000, submit)`:
  worked, `origin {"kind":"plugin","name":"wisprflow4agents"}`, and a turn started.

**Answer:** use `context` for what the model must read (the `check` command); that is the measured
channel. `text` is for the person, may still reach the model, and is not a reliable channel. A command that wants a model turn schedules the submit on a timer that fires after the
hook has returned (2 s worked; 0 ms did not).

## Q5. Timers: idle wake, `/clear`, resume, hot reload

- `/spike-arm 20000 submit` in an idle session: tick 1 called `$.prompt.submit`, the
  transcript showed `› Prompt from the wisprflow4agents plugin`, and the model answered
  `TIMER-OK` in a turn of its own. An idle session gets a turn.
- `/clear`: `session.end` with `reason: "clear"`, then ticks 3 and 4 kept coming from the
  same module instance under the new session id. No `session.start`. Timers and module
  variables survive.
- In-session `/resume <id>`: `session.end` with `reason: "resume"`, tick 5 came under the
  resumed id, same instance. No `session.start`. Timers survive.
- Exit, then `claude --resume <id>` (a new process): `session.start` with a new instance id,
  the same session id, and no ticks. The timer is gone with the old process.
- Hot reload (saving `register.tsx`): three saves gave three reloads, each a new instance and a
  `session.start` (debug: `session.start: raised for wisprflow4agents (loaded later)`). No tick
  after the first reload. Timers are dropped.

**Answer:** `session.start` is the right place to re-arm. It fires for every new process
(including a `--resume`) and every reload, which are exactly the cases that drop timers, and it
does not fire for `/clear` or in-session resume, where timers keep running. Re-arm from what
`$.store` holds; a reload leaves no duplicate timer behind. Note that after `/clear` or resume
a timer keeps running under a different session id, so watches keyed by session id should
follow `$.session.id()` or be keyed by something stable.

## Q6. `$.ui.toast` from a timer

The timer's `$.ui.toast('spike tick 2')` showed as a box in the top-right corner of the pane
(`│ spike tick 2 │`), drawn while the prompt was idle. **Answer:** shown.

## Q7. `$.fs` under `~/.wisprflow4agents/`

Ran `/spike-fs`: `home = await $.env.get('HOME')`, then `$.fs.write(home +
'/.wisprflow4agents/.spike/a/b/t.txt', 'one')`, `stat` through `$.process.run`, a second
write, `read`, `list`, `stat`, and a write to the literal path `~/.wisprflow4agents/...`.
`~/.wisprflow4agents` did not exist before.

- `$.env.get('HOME')` returned the home directory; writing under it worked.
- `$.fs.write` created all missing parents. Directories got mode `700` and the file `600`,
  even with umask `0022`.
- A second write kept the same inode: it rewrites in place, it does not write and rename.
- `read` returned the new text; `list` and `stat` worked.
- `~` is not expanded: the write to `~/.wisprflow4agents/...` created a directory literally
  named `~` in the session's working directory. Build paths from `$.env.get('HOME')`.
- No permission prompt and no refusal appeared. `$.fs` is not a tool call. Scope: the
  sessions ran in auto mode; another permission mode was not tried.
- Atomic create-if-absent: none in `$.fs`; `mkdir` through `$.process.run` is atomic (Q2).

## Hooks environment (for PKCE)

`/spike-env`: `crypto` object; `crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'))`
then `btoa` gave `ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=` (the correct digest);
`crypto.getRandomValues` worked; `TextEncoder`, `TextDecoder`, `btoa`, `atob`, `URL`,
`URLSearchParams`, `structuredClone`, `setTimeout` are functions. Global `fetch` is
`undefined`: the network is `$.http.fetch` only. PKCE can be done in the mod with no helpers.

## Rules the validator enforces that the docs do not state

- `$` may never be passed as an argument: `validate` refused `SPIKE[name]($, ...)` with
  "$ itself is passed as an argument ... $ is always spelled $.noun.event(...) at the call
  site". So `wispr.ts` and `watch.ts` get injected functions built as closures in the hook
  (`fetch: (u, i) => $.http.fetch(u, i)`), never `$`.
- A `command.run` hook whose matcher is not a literal, or whose command is not registered by a
  literal name, is listed as a gate ("gating hook without .catch"). Register literal names and
  the hook "answers its own command".
- The engine writes `tsconfig.json` at the plugin root and `.claude-plugin/types/` (with its
  own `.gitignore`) every time it loads the mod from this folder. `tsconfig.json` stays in the
  repository.
- In this host's sessions a command's output is labelled `wisprflow4agents+<other plugin>:`
  because another plugin hooks `command.run` too. That label depends on the host.

## Plugin skills, `skill.prompt`, `$.process.spawn`

Claude Code 2.1.322, plugin installed as `<project>/.claude/skills/wisprflow4agents`.

- A plugin skill `skills/watch/SKILL.md` is typed as `/wisprflow4agents:watch`; `skill.prompt`
  sees `skill: "wisprflow4agents:watch"` (with the prefix), `pluginName: "wisprflow4agents"`,
  `source: "plugin"`, and `text` = `Base directory for this skill: ...` plus the body with
  `$ARGUMENTS` already substituted. A matcher `{ skill: 'wisprflow4agents:watch' }` works.
- `skill.prompt` fires for a typed skill and for the model's Skill tool (`log me in to Wispr`
  made the model call `Skill(wisprflow4agents:login)`, and the hook's text came back).
- `disable-model-invocation: true`: the Skill tool refuses (`cannot be used with Skill tool due
  to disable-model-invocation`) and `skill.prompt` does not fire.
- A typed skill raises `prompt.submit` with `origin {"kind":"composer"}` and
  `command {"name":"wisprflow4agents:check","args":"all --since 2d"}` before its `skill.prompt`.
- A skill command typed during a running turn waits in the queue; its `prompt.submit` fires when
  it is dequeued (16.4 s after Enter during a 20 s Bash call, no `turnId`), and the skill text
  reached the transcript 82 ms after that. So a typed run's `skill.prompt` follows its
  `prompt.submit` within about 0.1 s either way.
- An agent whose agent file lists the skill under `skills:` did not receive it (the agent
  reported no preloaded skill text); the refusal for a run with no typed permit was not reached.
- `$.process.spawn`: pieces arrive as written (`pid ...\n`, then `b\n` one second later);
  `stream.return()` ends the loop with `{ done: true }` and the child is gone; a missing binary
  rejects the first `next()` (`ENOENT: Executable not found in $PATH`); a child that exits on
  its own ends with `{ done: true, value: { code, signal } }` (a bind clash: code 1). A child is
  killed when its session ends (tmux session killed: the listener was gone 1 s later).
- A prompt rewrite at `prompt.submit` reaches the transcript and `~/.claude/history.jsonl`: a
  pasted code appeared in neither, the redacted URL in both.
