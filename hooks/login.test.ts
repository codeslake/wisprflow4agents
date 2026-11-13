import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addressInUse, browserHosts, callbackFromOutput, findCallback, forwardArgv, forwardError, forwardUp, listenerArgvs, loginText, redactCallback } from './login.ts'

const URL1 = 'http://localhost:33418/callback?code=SECRET123&state=st-1'

test('findCallback picks the URL out of a typed prompt and drops trailing punctuation', () => {
  assert.equal(findCallback(`here it is: ${URL1}.`), URL1)
  assert.equal(findCallback(`(${URL1})`), URL1)
  assert.equal(findCallback(`"${URL1}" thanks`), URL1)
  assert.equal(findCallback('http://localhost:33418/other?code=x'), undefined)
  assert.equal(findCallback('log me in to wispr'), undefined)
})

test('redactCallback hides the code and keeps the state and the rest of the prompt', () => {
  const out = redactCallback(`done: ${URL1} and http://localhost:33418/callback?state=s2&code=X2#f`)
  assert.equal(out, 'done: http://localhost:33418/callback?code=REDACTED&state=st-1 and http://localhost:33418/callback?state=s2&code=REDACTED#f')
  assert.ok(!out.includes('SECRET123'))
  assert.equal(redactCallback('no url here, code=abc'), 'no url here, code=abc')
})

test('callbackFromOutput waits for a whole line, then gives the callback URL', () => {
  assert.equal(callbackFromOutput('listening\n'), undefined)
  assert.equal(callbackFromOutput('listening\ncallback code=a&sta'), undefined)
  assert.equal(callbackFromOutput('listening\ncallback code=a&state=b\n'), 'http://localhost:33418/callback?code=a&state=b')
})

// The real listener scripts, on a free port.
const has = (bin: string) => spawnSync(bin, ['--version']).status === 0
const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => ok(p))
    })
  })

function run(argv: string[], cwd?: string) {
  const c = spawn(argv[0], argv.slice(1), { cwd })
  let out = ''
  let err = ''
  c.stdout.on('data', (d) => (out += d))
  c.stderr.on('data', (d) => (err += d))
  const exited = new Promise<number | null>((ok) => c.on('exit', (code) => ok(code)))
  const until = async (re: RegExp) => {
    while (!re.test(out)) await new Promise((r) => setTimeout(r, 20))
  }
  return { c, exited, until, out: () => out, err: () => err }
}

test('addressInUse tells a taken port from any other failure to listen', () => {
  assert.ok(addressInUse('OSError: [Errno 98] Address already in use'))
  assert.ok(addressInUse('listen EADDRINUSE: address already in use 127.0.0.1:33418'))
  assert.ok(!addressInUse('SyntaxError: invalid syntax'))
  assert.ok(!addressInUse(''))
})

for (const [i, bin] of ['python3', 'node'].entries()) {
  test(`${bin} listener: one /callback with the right state, then exit; a second bind fails`, { skip: !has(bin) }, async () => {
    const port = await freePort()
    const a = run(listenerArgvs(port, 'st-1', 30)[i])
    await a.until(/listening\n/)

    const b = run(listenerArgvs(port, 'st-1', 30)[i]) // the port is the lock
    assert.notEqual(await b.exited, 0)
    assert.ok(!b.out().includes('listening'))
    assert.ok(addressInUse(b.err()), b.err())

    const base = `http://127.0.0.1:${port}`
    assert.equal((await fetch(`${base}/favicon.ico`)).status, 404)
    assert.equal((await fetch(`${base}/callback?code=x&state=wrong`)).status, 404)
    const r = await fetch(`${base}/callback?code=x&state=st-1`)
    assert.equal(r.status, 200)
    assert.match(await r.text(), /Signed in to Wispr Flow/)
    assert.equal(await a.exited, 0)
    assert.equal(callbackFromOutput(a.out()), 'http://localhost:33418/callback?code=x&state=st-1')

    // the port is free again at once: a new login gets a listener
    const c = run(listenerArgvs(port, 'st-2', 30)[i])
    await c.until(/listening\n/)
    c.c.kill()
    await c.exited
  })

  test(`${bin} listener exits on its own after its time`, { skip: !has(bin) }, async () => {
    const a = run(listenerArgvs(await freePort(), 's', 1)[i])
    await a.until(/listening\n/)
    assert.equal(await a.exited, 0)
  })

  test(`${bin} listener waits out a closed connection holding its port, then listens`, { skip: !has(bin) || !has('python3') }, async () => {
    // A client socket bound to the port without SO_REUSEADDR (what a TIME_WAIT one left by an
    // ordinary connect is) makes bind fail with nobody listening. Node sets SO_REUSEADDR on every
    // bind, so the holder is python; closing it with SO_LINGER 0 sends a RST and leaves no TIME_WAIT.
    const port = await freePort()
    const peer = createServer((s) => s.on('error', () => {})).listen(0, '127.0.0.1')
    await new Promise((ok) => peer.once('listening', ok))
    const holder = run([
      'python3', '-I', '-c',
      'import socket, struct, sys\n' +
        's = socket.socket(); s.bind(("127.0.0.1", int(sys.argv[1]))); s.connect(("127.0.0.1", int(sys.argv[2])))\n' +
        'print("held", flush=True); sys.stdin.read()\n' +
        's.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)); s.close()',
      String(port), String((peer.address() as { port: number }).port),
    ])
    await holder.until(/held\n/)
    try {
      const a = run(listenerArgvs(port, 's', 30)[i])
      await a.until(/waiting\n/)
      await new Promise((r) => setTimeout(r, 1200))
      assert.equal(a.c.exitCode, null, a.err())
      assert.ok(!a.out().includes('listening'))
      holder.c.stdin.end() // release
      await a.until(/listening\n/)
      assert.equal((await fetch(`http://127.0.0.1:${port}/callback?code=x&state=s`)).status, 200)
      assert.equal(await a.exited, 0)
    } finally {
      holder.c.kill()
      peer.close()
    }
  })

  test(`${bin} listener ignores modules in its working directory`, { skip: !has(bin) }, async () => {
    // a project holding files named like the modules the listener imports must not run them
    const dir = mkdtempSync(join(tmpdir(), 'wf4a-cwd-'))
    try {
      const evil = 'import sys; sys.stderr.write("SHADOWED"); sys.exit(7)\n'
      for (const f of ['threading.py', 'os.py', 'urllib.py']) writeFileSync(join(dir, f), evil)
      mkdirSync(join(dir, 'http'))
      writeFileSync(join(dir, 'http', '__init__.py'), evil)
      mkdirSync(join(dir, 'node_modules', 'http'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'http', 'index.js'), 'process.stderr.write("SHADOWED"); process.exit(7)\n')
      writeFileSync(join(dir, 'http.js'), 'process.stderr.write("SHADOWED"); process.exit(7)\n')
      const a = run(listenerArgvs(await freePort(), 's', 1)[i], dir)
      assert.equal(await a.exited, 0, a.err())
      assert.ok(a.out().includes('listening'))
      assert.ok(!a.err().includes('SHADOWED'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('browserHosts takes comma-separated ssh hosts and drops anything that is not one', () => {
  assert.deepEqual(browserHosts(' laptop , me@desk.lan,,'), ['laptop', 'me@desk.lan'])
  assert.deepEqual(browserHosts(undefined), [])
  assert.deepEqual(browserHosts(''), [])
  // an option or a shell word in place of a host never reaches ssh's argv
  assert.deepEqual(browserHosts('-oProxyCommand=touch /tmp/x,ok-host,a b,x;y,$(id)'), ['ok-host'])
})

test('forwardArgv: the reverse forward of the callback port to one host, verbose so success shows', () => {
  assert.deepEqual(forwardArgv(33418, 'laptop'), [
    'ssh', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-R', '33418:127.0.0.1:33418', '-v', 'laptop',
  ])
})

test('forwardUp and forwardError read ssh -v stderr', () => {
  // lines measured from OpenSSH 8.9 -v
  const up =
    'OpenSSH_8.9p1\ndebug1: /home/u/.ssh/config line 3: Applying options for laptop\n' +
    'Authenticated to laptop ([10.0.0.2]:22) using "publickey".\ndebug1: remote forward success for: listen 33418, connect 127.0.0.1:33418\n'
  assert.ok(forwardUp(up, 33418))
  assert.ok(!forwardUp(up.replace('success', 'failure'), 33418))
  assert.ok(!forwardUp('debug1: remote forward success for: listen 2222, connect 127.0.0.1:2222\n', 33418))
  const busy =
    'OpenSSH_8.9p1\nAuthenticated to laptop using "publickey".\ndebug1: remote forward failure for: listen 33418, connect 127.0.0.1:33418\n' +
    'Error: remote port forwarding failed for listen port 33418\n'
  assert.equal(forwardError(busy), 'Error: remote port forwarding failed for listen port 33418')
  assert.equal(
    forwardError('OpenSSH_8.9p1\nssh: Could not resolve hostname nope.invalid: Name or service not known\r\n'),
    'ssh: Could not resolve hostname nope.invalid: Name or service not known',
  )
  assert.equal(forwardError('OpenSSH_8.9p1\ndebug1: Connecting to x\n'), undefined) // only debug lines: no reason to show
  assert.equal(forwardError('x'.repeat(500))?.length, 200)
})

test('loginText says which path is armed', () => {
  const url = 'https://auth.example/authorize?x=1'
  const local = loginText(url, 15)
  assert.ok(local.includes(`\n\n${url}\n\n`))
  assert.match(local, /Open the link in a browser on this machine/)
  assert.match(local, /copy that whole address and paste it here/)
  assert.match(local, /The link works for 15 minutes\./)

  const fwd = loginText(url, 15, { via: 'laptop' })
  assert.ok(fwd.includes(`\n\n${url}\n\n`))
  assert.match(fwd, /Open this link in the browser on laptop; nothing to paste\./)
  assert.doesNotMatch(fwd, /paste it here/)
  assert.match(fwd, /The link works for 15 minutes\./)

  const failed = loginText(url, 15, { failed: ['laptop: Error: remote port forwarding failed for listen port 33418'] })
  assert.match(failed, /No ssh forward to the browser's machine \(laptop: Error: remote port forwarding failed for listen port 33418\)/)
  assert.match(failed, /copy that whole address and paste it here/)

  const opening = loginText(url, 15, { opening: ['laptop', 'desk'] })
  assert.match(opening, /The ssh forward to laptop, desk is still opening; a notice says when it is up/)
  assert.match(opening, /Then open this link in the browser there; nothing to paste/)
  assert.doesNotMatch(opening, /paste it here|on this machine/)
})
