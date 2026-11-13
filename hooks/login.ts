// Finishing a Wispr login: the loopback listener (RFC 8252) and a callback URL pasted into a
// prompt. Pure: the mod spawns the listener and reads its stdout; these helpers build its argv
// and parse what it prints, and find and redact a pasted callback URL.

export const PORT = 33418
const CALLBACK = `http://localhost:${PORT}/callback?`

const PAGE_OK = 'Signed in to Wispr Flow. Return to Claude Code; you can close this tab.'
const PAGE_ERR = 'Wispr Flow sign-in did not finish. Return to Claude Code for details.'

// Each listener takes `<port> <state> <seconds>`: it binds 127.0.0.1:<port>, prints `listening`,
// answers one GET /callback carrying <state> (other requests get a 404 and it keeps going), prints
// `callback <query>`, and exits; it also exits after <seconds>. When the port is taken and a
// connect to it succeeds, another listener has it: exit non-zero ("address already in use"). When
// the connect is refused, a closed connection that used the port as its source (TIME_WAIT, up to
// 60 s; measured often on a busy host) holds it: print `waiting` once and retry every 0.5 s.
const PY = `
import sys, os, errno, socket, threading, time, http.server, urllib.parse
port, state, secs = int(sys.argv[1]), sys.argv[2], float(sys.argv[3])
t = threading.Timer(secs, lambda: os._exit(0))
t.daemon = True
t.start()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(u.query)
        ok = u.path == '/callback' and q.get('state') == [state]
        self.send_response(200 if ok else 404)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.end_headers()
        self.wfile.write(((${JSON.stringify(PAGE_OK)} if 'code' in q else ${JSON.stringify(PAGE_ERR)}) if ok else 'Not found').encode())
        if ok:
            print('callback ' + u.query, flush=True)
            os._exit(0)
    def log_message(self, *a):
        pass
said = False
while True:
    try:
        srv = http.server.HTTPServer(('127.0.0.1', port), H)
        break
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        try:
            socket.create_connection(('127.0.0.1', port), 2).close()
            stale = False
        except ConnectionRefusedError:
            stale = True
        except OSError:
            stale = False
        if not stale:
            raise e
        if not said:
            said = True
            print('waiting', flush=True)
        time.sleep(0.5)
print('listening', flush=True)
srv.serve_forever()
`
const JS = `
const [port, state, secs] = process.argv.slice(-3)
const srv = require('node:http').createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost')
  const ok = u.pathname === '/callback' && u.searchParams.get('state') === state
  res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(ok ? (u.searchParams.has('code') ? ${JSON.stringify(PAGE_OK)} : ${JSON.stringify(PAGE_ERR)}) : 'Not found', () => {
    if (ok) process.stdout.write('callback ' + u.search.slice(1) + '\\n', () => process.exit(0))
  })
})
const fail = (e) => { console.error(e.message); process.exit(1) }
let said = false
srv.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') fail(e)
  const c = require('node:net').connect(Number(port), '127.0.0.1')
  c.on('connect', () => fail(e))
  c.on('error', (ce) => {
    if (ce.code !== 'ECONNREFUSED') fail(e)
    if (!said) console.log('waiting')
    said = true
    setTimeout(listen, 500)
  })
})
const listen = () => srv.listen(Number(port), '127.0.0.1', () => console.log('listening'))
setTimeout(() => process.exit(0), Number(secs) * 1000)
listen()
`

/** The argv lists to try in order (python3, else node) for a listener on `port`. */
export function listenerArgvs(port: number, state: string, seconds: number): string[][] {
  const a = [String(port), state, String(Math.max(1, Math.ceil(seconds)))]
  return [['python3', '-I', '-c', PY, ...a], ['node', '-e', JS, ...a]] // -I: no cwd, PYTHONPATH or user site on sys.path
}

/** Whether a listener's stderr says the port is taken (by another session's listener), as
 * opposed to a runtime that cannot listen at all. Python: Errno 98 (Linux) or 48 (macOS), WinError
 * 10048; node: EADDRINUSE. */
export function addressInUse(stderr: string): boolean {
  return /address already in use|EADDRINUSE|10048/i.test(stderr)
}

/** The callback URL once the listener's stdout so far holds a whole `callback <query>` line. */
export function callbackFromOutput(out: string): string | undefined {
  const m = /^callback (.*)\r?\n/m.exec(out)
  return m ? CALLBACK + m[1] : undefined
}

/** The ssh hosts where the person's browser runs, from a comma-separated setting. An entry that
 * is not a plain `[user@]host` (an option such as `-oProxyCommand=...`, a shell word) is dropped. */
export function browserHosts(setting: string | undefined): string[] {
  return (setting ?? '').split(',').map((h) => h.trim()).filter((h) => /^[\w.@:-]+$/.test(h) && !h.startsWith('-'))
}

/** ssh holding `localhost:<port>` on `host` open back to this machine's listener. `-v` because
 * only its debug line says the forward was accepted; ssh -N prints nothing else on success. */
export function forwardArgv(port: number, host: string): string[] {
  const o = ['BatchMode=yes', 'ExitOnForwardFailure=yes', 'ConnectTimeout=10', 'ControlMaster=no', 'ControlPath=none']
  return ['ssh', '-N', ...o.flatMap((x) => ['-o', x]), '-R', `${port}:127.0.0.1:${port}`, '-v', host]
}

/** Whether ssh's stderr so far says the remote forward of `port` was accepted. */
export function forwardUp(stderr: string, port: number): boolean {
  return stderr.includes(`remote forward success for: listen ${port},`)
}

/** Why ssh ended without a forward: its last line that is not debug, the banner or the login
 * notice (debug lines name local ssh config files, so they are never shown). */
export function forwardError(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim())
  return lines.filter((l) => l && !/^(debug\d|OpenSSH_|Authenticated to )/.test(l)).pop()?.slice(0, 200)
}

/** How the browser reaches the listener: through an ssh forward to `via`, not (the hosts that
 * `failed`, each with its reason), not yet (forwards still `opening`), or, left out, only locally. */
export type Route = { via: string } | { failed: string[] } | { opening: string[] }

/** What the model shows for a login: the link and the path that finishes it. */
export function loginText(url: string, minutes: number, route?: Route): string {
  const head =
    'Show the user this Wispr Flow sign-in link exactly as written (do not shorten, wrap or reformat it) and the steps below. ' +
    'You cannot sign in for them, and signing in reads no notes.\n\n' +
    `${url}\n\n`
  const tail = `The link works for ${minutes} minutes.`
  if (route && 'via' in route)
    return head + `Open this link in the browser on ${route.via}; nothing to paste. The page then says "Signed in to Wispr Flow" and this session shows a notice.\n` + tail
  if (route && 'opening' in route)
    return head + `The ssh forward to ${route.opening.join(', ')} is still opening; a notice says when it is up. Then open this link in the browser there; nothing to paste. The page says "Signed in to Wispr Flow" and this session shows a notice.\n` + tail
  const why =
    route && 'failed' in route
      ? `No ssh forward to the browser's machine (${route.failed.join('; ')}), so the link reaches this machine only.\n`
      : ''
  return (
    head +
    why +
    '1. Open the link in a browser on this machine and sign in. The page then says "Signed in to Wispr Flow" and this session shows a notice.\n' +
    `2. If the browser is on another device, or it ends on a http://localhost:${PORT}/callback?... page that does not load, ` +
    'copy that whole address and paste it here as a message.\n' +
    tail
  )
}

const PASTED = /http:\/\/localhost:33418\/callback\?[^\s"'<>]+/g
const trim = (u: string) => u.replace(/[.,;:!?)\]]+$/, '')

/** The first callback URL in a typed prompt, without trailing punctuation. */
export function findCallback(text: string): string | undefined {
  const m = text.match(PASTED)
  return m ? trim(m[0]) : undefined
}

/** `text` with the `code` of every callback URL in it replaced. */
export function redactCallback(text: string): string {
  return text.replace(PASTED, (u) => u.replace(/([?&]code=)[^&#]*/g, '$1REDACTED'))
}
