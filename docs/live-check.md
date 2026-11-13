# Live check on a real Wispr Flow account

Run on a Linux server (Claude Code 2.1.323), plugin installed as a skills-directory
plugin from a copy of this code, browser on a laptop reached through the optional
login-time ssh forward (`WISPRFLOW4AGENTS_BROWSER_SSH=<laptop>`). Two test sessions, debug
log on. Note text and names are left out on purpose.

| Check | Result |
|---|---|
| `/wisprflow4agents:login` with a forward host | listener and `ssh -R` spawned 33-36 ms apart; text said to open the link on the laptop, nothing to paste; laptop showed a listener on 33418 (IPv4 and IPv6) |
| Sign-in by clicking the link only | the browser callback reached the listener through the forward; tokens stored 1 min 16 s after the link was shown; toast `Signed in to Wispr Flow. Folders: ...` listing the account's folders |
| Nothing left after login | no listener or ssh process on the server, no listener on the laptop |
| `/wisprflow4agents:watch test` | `Watching folder "test" every 5m. 1 notes known` |
| A note added to `test` in the app | the session woke once, 2 min 39 s later, with one `New:` entry (title, time, folder, share link, excerpt); the model reported it without reading the full note |
| `/wisprflow4agents:check all` | listed the notes changed in the last day (2) |
| Second session watching the same folder | over two 5-minute ticks the two sessions made 2 polls in total (one per tick, alternating sessions), not 4: the poll is shared |
| `/wisprflow4agents:logout` | `Signed out ...`; the store keeps only the two `watches:` entries (no tokens, client or cache) |

In an earlier run, one login showed a 17 s gap between the listener start and the ssh
forward, so the login text went out before the forward was up and offered the paste fallback.
Not reproduced in three later runs; the forward now starts on the listener's first output and the
"still opening" text no longer offers paste.

Not covered: a browser on the same machine (`::1` callback), a scratchpad note, macOS and Windows
servers, the node listener fallback.
