import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wispr, pkceChallenge, LoginNeeded, AUTH, MCP_URL, REDIRECT_URI } from './wispr.ts'
import type { Deps, Store, Response } from './wispr.ts'

// In-memory store with JSON round-trips, so sessions sharing it see copies, as on disk.
function memStore(): Store & { data: Record<string, string> } {
  const data: Record<string, string> = {}
  return {
    data,
    get: async (k) => (k in data ? JSON.parse(data[k]) : undefined),
    set: async (k, v) => void (data[k] = JSON.stringify(v)),
    delete: async (k) => void delete data[k],
  }
}

// A shared virtual clock: sleep advances it and yields to the event loop.
function clock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
      await new Promise((r) => setImmediate(r))
    },
    advance: (ms: number) => void (t += ms),
  }
}

type Handler = (url: string, init: any) => Response | Promise<Response>
const res = (status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): Response => ({
  status,
  ok: status >= 200 && status < 300,
  headers,
  text: typeof body === 'string' ? body : JSON.stringify(body),
})

function fakeFetch(h: Handler) {
  const calls: { url: string; init: any }[] = []
  const f = async (url: string, init: any) => {
    calls.push({ url, init })
    await new Promise((r) => setImmediate(r))
    return h(url, init)
  }
  return Object.assign(f, { calls })
}

const form = (init: any) => Object.fromEntries(new URLSearchParams(init.body))
const HOUR = 3600_000

function setup(h: Handler, store = memStore(), clk = clock()) {
  const fetch = fakeFetch(h)
  const deps: Deps = { fetch, store, now: clk.now, sleep: clk.sleep }
  return { w: wispr(deps), fetch, store, clk, deps }
}

// Token endpoint that rotates: refresh token rN -> access aN+1, refresh rN+1.
function rotatingToken(counter = { n: 0 }) {
  return (url: string, init: any): Response | undefined => {
    if (url !== AUTH + '/oauth2/token') return undefined
    const p = form(init)
    if (p.grant_type !== 'refresh_token') return undefined
    if (p.refresh_token !== 'r' + counter.n) return res(400, { error: 'invalid_grant' })
    counter.n++
    return res(200, { access_token: 'a' + counter.n, refresh_token: 'r' + counter.n, expires_in: 259200 })
  }
}

test('PKCE S256 matches the RFC 7636 appendix B vector', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('registerClient registers once and caches the client', async () => {
  const { w, fetch, store } = setup((url, init) => {
    assert.equal(url, AUTH + '/oauth2/register')
    const b = JSON.parse(init.body)
    assert.deepEqual(b.grant_types, ['authorization_code', 'refresh_token'])
    assert.equal(b.token_endpoint_auth_method, 'none')
    assert.deepEqual(b.redirect_uris, [REDIRECT_URI])
    return res(201, { client_id: 'c1' })
  })
  assert.equal(await w.registerClient(), 'c1')
  assert.equal(await w.registerClient(), 'c1')
  assert.equal(fetch.calls.length, 1)
  assert.deepEqual(await store.get('client'), { client_id: 'c1' })
})

test('authorizeUrl builds a PKCE request and finishLogin exchanges the code', async () => {
  const clk = clock()
  const { w, fetch, store } = setup((url, init) => {
    if (url.endsWith('/oauth2/register')) return res(201, { client_id: 'c1' })
    assert.equal(url, AUTH + '/oauth2/token')
    const p = form(init)
    assert.equal(p.grant_type, 'authorization_code')
    assert.equal(p.code, 'CODE')
    assert.equal(p.client_id, 'c1')
    assert.equal(p.redirect_uri, REDIRECT_URI)
    assert.equal(p.resource, MCP_URL)
    assert.equal(p.code_verifier, pending.verifier)
    return res(200, { access_token: 'a0', refresh_token: 'r0', id_token: 'x', expires_in: 259200 })
  }, memStore(), clk)
  const pending = await w.authorizeUrl()
  const u = new URL(pending.url)
  assert.equal(u.origin + u.pathname, AUTH + '/oauth2/authorize')
  const q = Object.fromEntries(u.searchParams)
  assert.equal(q.client_id, 'c1')
  assert.equal(q.state, pending.state)
  assert.equal(q.code_challenge_method, 'S256')
  assert.equal(q.code_challenge, await pkceChallenge(pending.verifier))
  assert.equal(q.scope, 'openid offline_access')
  assert.equal(q.resource, MCP_URL)
  assert.ok(pending.verifier.length >= 43)

  await w.finishLogin(`${REDIRECT_URI}?code=CODE&state=${pending.state}`, pending)
  assert.deepEqual(await store.get('tokens'), { access_token: 'a0', refresh_token: 'r0', expires_at: clk.now() + 259200_000 })
  assert.equal(fetch.calls.length, 2)
})

test('finishLogin refuses a state mismatch without calling the token endpoint', async () => {
  const { w, fetch, store } = setup(() => res(201, { client_id: 'c1' }))
  const pending = await w.authorizeUrl()
  await assert.rejects(w.finishLogin(`${REDIRECT_URI}?code=CODE&state=other`, pending), /state/)
  assert.equal(fetch.calls.length, 1)
  assert.equal(await store.get('tokens'), undefined)
})

test('accessToken returns a valid token without refreshing', async () => {
  const { w, fetch, store, clk } = setup(() => assert.fail('no fetch'))
  await store.set('tokens', { access_token: 'a0', refresh_token: 'r0', expires_at: clk.now() + HOUR })
  assert.equal(await w.accessToken(), 'a0')
  assert.equal(fetch.calls.length, 0)
})

test('accessToken with no tokens raises LoginNeeded', async () => {
  const { w } = setup(() => assert.fail('no fetch'))
  await assert.rejects(w.accessToken(), LoginNeeded)
})

test('refresh under 5 minutes left persists the rotated pair', async () => {
  const { w, store, clk } = setup((url, init) => rotatingToken()(url, init)!)
  await store.set('client', { client_id: 'c1' })
  await store.set('tokens', { access_token: 'a0', refresh_token: 'r0', expires_at: clk.now() + 4 * 60_000 })
  assert.equal(await w.accessToken(), 'a1')
  const t = await store.get('tokens')
  assert.equal(t.refresh_token, 'r1')
  assert.equal(t.access_token, 'a1')
  assert.equal(t.expires_at, clk.now() + 259200_000)
  assert.equal(await store.get('refresh_lease'), undefined)
})

test('two sessions sharing a store refresh once', async () => {
  const store = memStore()
  const clk = clock()
  const counter = { n: 0 }
  const tokenCalls: string[] = []
  const h: Handler = (url, init) => {
    tokenCalls.push(form(init).refresh_token)
    return rotatingToken(counter)(url, init)!
  }
  const A = setup(h, store, clk)
  const B = setup(h, store, clk)
  await store.set('client', { client_id: 'c1' })
  await store.set('tokens', { access_token: 'a0', refresh_token: 'r0', expires_at: clk.now() + 60_000 })
  const [a, b, a2] = await Promise.all([A.w.accessToken(), B.w.accessToken(), A.w.accessToken()])
  assert.deepEqual([a, b, a2], ['a1', 'a1', 'a1'])
  assert.deepEqual(tokenCalls, ['r0'])
  assert.equal((await store.get('tokens')).refresh_token, 'r1')
})

test('a session that loses the race uses the pair another session rotated', async () => {
  // B holds a stale pair in mind: the store already has the rotated one when B gets invalid_grant.
  const store = memStore()
  const clk = clock()
  await store.set('client', { client_id: 'c1' })
  await store.set('tokens', { access_token: 'a0', refresh_token: 'r0', expires_at: clk.now() + 60_000 })
  const { w } = setup(async (url, init) => {
    // another session rotates while our refresh is in flight
    await store.set('tokens', { access_token: 'a1', refresh_token: 'r1', expires_at: clk.now() + 72 * HOUR })
    assert.equal(form(init).refresh_token, 'r0')
    return res(400, { error: 'invalid_grant' })
  }, store, clk)
  assert.equal(await w.accessToken(), 'a1')
  assert.equal((await store.get('tokens')).refresh_token, 'r1')
})

test('invalid_grant with an unchanged pair clears tokens and raises LoginNeeded', async () => {
  const { w, store, clk } = setup(() => res(400, { error: 'invalid_grant', error_description: 'expired' }))
  await store.set('client', { client_id: 'c1' })
  await store.set('tokens', { access_token: 'a0', refresh_token: 'r0', expires_at: clk.now() + 60_000 })
  await assert.rejects(w.accessToken(), LoginNeeded)
  assert.equal(await store.get('tokens'), undefined)
  assert.equal(await store.get('refresh_lease'), undefined)
})

test('a refresh that fails otherwise keeps the tokens', async () => {
  const { w, store, clk } = setup(() => res(503, 'down', {}))
  await store.set('client', { client_id: 'c1' })
  await store.set('tokens', { access_token: 'a0', refresh_token: 'r0', expires_at: clk.now() + 60_000 })
  await assert.rejects(w.accessToken(), /503/)
  assert.equal((await store.get('tokens')).refresh_token, 'r0')
})

// MCP server fake: answers initialize, initialized and tools/call.
function mcp(answer: (msg: any, auth: string) => Response, log: any[] = []): Handler {
  return (url, init) => {
    assert.equal(url, MCP_URL)
    const msg = JSON.parse(init.body)
    const auth = init.headers.Authorization
    log.push({ method: msg.method, sid: init.headers['Mcp-Session-Id'], auth, version: init.headers['MCP-Protocol-Version'] })
    if (msg.method === 'initialize') {
      return res(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }, { 'content-type': 'application/json', 'mcp-session-id': 'S1' })
    }
    if (msg.method === 'notifications/initialized') return res(202, '', {})
    return answer(msg, auth)
  }
}

async function loggedIn(h: Handler) {
  const s = setup(h)
  await s.store.set('client', { client_id: 'c1' })
  await s.store.set('tokens', { access_token: 'a0', refresh_token: 'r0', expires_at: s.clk.now() + HOUR })
  return s
}

test('call sends the session id and returns structuredContent from a JSON body', async () => {
  const log: any[] = []
  const { w } = await loggedIn(mcp((msg) => {
    assert.equal(msg.method, 'tools/call')
    assert.deepEqual(msg.params, { name: 'list_folders', arguments: { x: 1 } })
    return res(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { folders: [] } } })
  }, log))
  assert.deepEqual(await w.call('list_folders', { x: 1 }), { folders: [] })
  assert.deepEqual(log.map((l) => [l.method, l.sid ?? null]), [['initialize', null], ['notifications/initialized', 'S1'], ['tools/call', 'S1']])
  assert.ok(log.every((l) => l.auth === 'Bearer a0' && l.version === '2025-06-18'))
})

test('call parses an SSE body and falls back to content[0].text', async () => {
  const { w } = await loggedIn(mcp((msg) => {
    const ping = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })
    const ans = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"meetings":[1]}' }] } })
    return res(200, `event: message\ndata: ${ping}\n\nevent: message\ndata: ${ans}\n\n`, { 'content-type': 'text/event-stream' })
  }))
  assert.deepEqual(await w.call('search_meetings', {}), { meetings: [1] })
})

test('call skips a non-JSON SSE data line (keep-alive)', async () => {
  const { w } = await loggedIn(mcp((msg) => {
    const ans = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { ok: 1 } } })
    return res(200, `data: keep-alive\n\ndata: ${ans}\n\n`, { 'content-type': 'text/event-stream' })
  }))
  assert.deepEqual(await w.call('list_folders', {}), { ok: 1 })
})

test('call throws when no message answers the request id', async () => {
  let body: (id: number) => Response = (id) => res(200, { jsonrpc: '2.0', id: id + 100, result: { structuredContent: { other: true } } })
  const { w } = await loggedIn(mcp((msg) => body(msg.id)))
  await assert.rejects(w.call('list_folders', {}), /tools\/call: no answer to request 2 \(HTTP 200\)/)
  body = () => res(200, '')
  await assert.rejects(w.call('list_folders', {}), /no answer to request/)
  body = () => res(200, `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\n\n`, { 'content-type': 'text/event-stream' })
  await assert.rejects(w.call('list_folders', {}), /no answer to request/)
})

test('call turns isError and JSON-RPC errors into errors with their text', async () => {
  let mode = 'isError'
  const { w } = await loggedIn(mcp((msg) =>
    mode === 'isError'
      ? res(200, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Cloud Sync must be enabled' }] } })
      : res(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } }),
  ))
  await assert.rejects(w.call('get_meeting', {}), /Cloud Sync must be enabled/)
  mode = 'rpc'
  await assert.rejects(w.call('nope', {}), /Unknown tool/)
})

test('call on 401 refreshes once and retries with the new token', async () => {
  const counter = { n: 0 }
  const rot = rotatingToken(counter)
  const { w, store } = await loggedIn((url, init) =>
    url.startsWith(AUTH)
      ? rot(url, init)!
      : init.headers.Authorization === 'Bearer a0'
        ? res(401, { error: 'invalid_token' })
        : mcp((msg) => res(200, { jsonrpc: '2.0', id: msg.id, result: { structuredContent: { ok: true } } }))(url, init),
  )
  assert.deepEqual(await w.call('list_folders', {}), { ok: true })
  assert.equal(counter.n, 1)
  assert.equal((await store.get('tokens')).refresh_token, 'r1')
})

test('call raises LoginNeeded when the retry is 401 too', async () => {
  const counter = { n: 0 }
  const rot = rotatingToken(counter)
  const { w } = await loggedIn((url, init) => (url.startsWith(AUTH) ? rot(url, init)! : res(401, { error: 'invalid_token' })))
  await assert.rejects(w.call('list_folders', {}), LoginNeeded)
  assert.equal(counter.n, 1)
})

test('a code exchange or refresh without refresh_token keeps the previous one', async () => {
  const clk = clock()
  const { w, store } = setup((url) =>
    url.endsWith('/oauth2/register') ? res(201, { client_id: 'c1' }) : res(200, { access_token: 'aN', expires_in: 259200 }), memStore(), clk)
  await store.set('tokens', { access_token: 'a0', refresh_token: 'r0', expires_at: clk.now() - 1 })
  const pending = await w.authorizeUrl()
  await w.finishLogin(`${REDIRECT_URI}?code=CODE&state=${pending.state}`, pending)
  assert.deepEqual(await store.get('tokens'), { access_token: 'aN', refresh_token: 'r0', expires_at: clk.now() + 259200_000 })
  clk.advance(259200_000)
  assert.equal(await w.accessToken(), 'aN')
  assert.equal((await store.get('tokens')).refresh_token, 'r0')
})

test('a refresh that hands back the refused token is retried once, then fails', async () => {
  const { w, store, clk, fetch } = setup(() => res(200, { access_token: 'a0', refresh_token: 'r1', expires_in: 259200 }))
  await store.set('client', { client_id: 'c1' })
  await store.set('tokens', { access_token: 'a0', refresh_token: 'r0', expires_at: clk.now() + HOUR })
  await assert.rejects(w.accessToken('a0'), /refused token/)
  assert.equal(fetch.calls.length, 2)
})

test('logout deletes tokens and client', async () => {
  const { w, store } = await loggedIn(() => assert.fail('no fetch'))
  await w.logout()
  assert.equal(await store.get('tokens'), undefined)
  assert.equal(await store.get('client'), undefined)
})
