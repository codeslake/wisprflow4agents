// Wispr Flow MCP client and OAuth (auth code + PKCE, refresh with rotation). Pure: no Node, no
// DOM, no imports. The caller injects fetch, store and clock as closures (never `$` itself).
// Uses only globals the mod has: crypto.subtle, crypto.getRandomValues, TextEncoder, btoa, URL.

export const AUTH = 'https://mcp-auth.wisprflow.com'
export const MCP_URL = 'https://api.wisprflow.ai/connect/mcp'
export const REDIRECT_URI = 'http://localhost:33418/callback'
export const PROTOCOL = '2025-06-18'
const SCOPE = 'openid offline_access'

// Store keys, shared by every session on the machine.
const CLIENT = 'client' // { client_id }
const TOKENS = 'tokens' // Tokens
const LEASE = 'refresh_lease' // { owner, until }

const SKEW_MS = 5 * 60_000 // refresh when less than this is left
const LEASE_MS = 30_000
const SETTLE_MS = 300 // a lease is ours only if it still names us after this
const POLL_MS = 500

/** The shape of `$.http.fetch`'s answer. Header names are lower-cased. */
export interface Response {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
}
export type Fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>
export interface Store {
  get(key: string): Promise<any>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}
export interface Deps {
  fetch: Fetch
  store: Store
  now: () => number
  sleep: (ms: number) => Promise<void>
}
export interface Tokens {
  access_token: string
  refresh_token: string
  expires_at: number // ms, from deps.now()
}
/** What authorizeUrl returns; the caller keeps `verifier` and `state` until finishLogin. */
export interface Pending {
  url: string
  verifier: string
  state: string
}

/** No usable tokens: the person must sign in again (/wisprflow4agents:login). */
export class LoginNeeded extends Error {
  constructor(message = 'Wispr Flow login needed: run /wisprflow4agents:login') {
    super(message)
    this.name = 'LoginNeeded'
  }
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const randomB64url = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)))

/** PKCE S256 code challenge of `verifier`. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

const parse = (s: string) => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}
const json = (r: Response) => parse(r.text)

// The JSON-RPC message answering `id` in a JSON or SSE body, if any; a non-JSON data line is skipped.
function rpcAnswer(r: Response, id: number): any {
  const msgs = !(r.headers['content-type'] ?? '').includes('text/event-stream')
    ? [json(r)]
    : r.text
        .split(/\r?\n\r?\n/)
        .map((ev) => parse(ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')))
  return msgs.find((m) => m?.id === id)
}

class Unauthorized extends Error {}

/**
 * The client. Methods:
 * - registerClient(): dynamic registration once per machine, cached in the store; returns client_id.
 * - authorizeUrl(): the browser URL plus the PKCE verifier and state to keep for finishLogin.
 * - finishLogin(pastedUrl, pending): checks state, exchanges the code, stores the tokens.
 * - accessToken(): a token with more than 5 minutes left, refreshing (once per machine) if needed.
 * - call(tool, args): one MCP tools/call; structuredContent, else content[0].text parsed as JSON.
 * - logout(): forgets tokens and client.
 * LoginNeeded is thrown wherever only a new browser login can help.
 */
export function wispr(deps: Deps) {
  const { fetch, store, now, sleep } = deps
  const owner = randomB64url(9) // this instance's lease name
  let inflight: Promise<string> | undefined

  async function tokenRequest(params: Record<string, string>): Promise<Response> {
    return fetch(AUTH + '/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...params, resource: MCP_URL }).toString(),
    })
  }

  // Persist before returning: the old refresh token is dead once the server rotates it.
  async function saveTokens(r: Response, old?: Tokens): Promise<Tokens> {
    const b = json(r)
    if (!b?.access_token) throw new Error(`Wispr token endpoint: no access_token (HTTP ${r.status})`)
    const t: Tokens = {
      access_token: b.access_token,
      refresh_token: b.refresh_token ?? old?.refresh_token,
      expires_at: now() + (b.expires_in ?? 3600) * 1000,
    }
    await store.set(TOKENS, t)
    return t
  }

  async function registerClient(): Promise<string> {
    const c = await store.get(CLIENT)
    if (c?.client_id) return c.client_id
    const r = await fetch(AUTH + '/oauth2/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'wisprflow4agents',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        redirect_uris: [REDIRECT_URI],
      }),
    })
    const b = json(r)
    if (!r.ok || !b?.client_id) throw new Error(`Wispr client registration failed: HTTP ${r.status} ${r.text.slice(0, 200)}`)
    await store.set(CLIENT, { client_id: b.client_id })
    return b.client_id
  }

  async function authorizeUrl(): Promise<Pending> {
    const client_id = await registerClient()
    const verifier = randomB64url(32)
    const state = randomB64url(16)
    const q = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
      resource: MCP_URL,
    })
    return { url: `${AUTH}/oauth2/authorize?${q}`, verifier, state }
  }

  async function finishLogin(pastedUrl: string, pending: Pick<Pending, 'verifier' | 'state'>): Promise<void> {
    const q = new URL(pastedUrl.trim()).searchParams
    if (q.get('error')) throw new Error(`Wispr login refused: ${q.get('error_description') ?? q.get('error')}`)
    if (q.get('state') !== pending.state) throw new Error('Wispr login: state does not match; run /wisprflow4agents:login again')
    const code = q.get('code')
    if (!code) throw new Error('Wispr login: the pasted URL has no code')
    const r = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: await registerClient(),
      code_verifier: pending.verifier,
    })
    if (!r.ok) throw new Error(`Wispr code exchange failed: HTTP ${r.status} ${r.text.slice(0, 200)}`)
    await saveTokens(r, await store.get(TOKENS))
  }

  const usable = (t: Tokens | undefined, stale?: string) =>
    !!t && t.access_token !== stale && t.expires_at - now() > SKEW_MS

  // Runs only while this instance holds the lease.
  async function refresh(stale?: string): Promise<string> {
    const t: Tokens | undefined = await store.get(TOKENS) // another session may have rotated meanwhile
    if (!t) throw new LoginNeeded()
    if (usable(t, stale)) return t.access_token
    const c = await store.get(CLIENT)
    if (!c?.client_id) throw new LoginNeeded()
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.client_id })
    if (r.ok) return (await saveTokens(r, t)).access_token
    if (r.status === 400 && json(r)?.error === 'invalid_grant') {
      // Lost a race the lease did not prevent: a pair rotated by another session is still good.
      const again: Tokens | undefined = await store.get(TOKENS)
      if (again && again.refresh_token !== t.refresh_token) return again.access_token
      await store.delete(TOKENS)
      throw new LoginNeeded()
    }
    throw new Error(`Wispr token refresh failed: HTTP ${r.status} ${r.text.slice(0, 200)}`)
  }

  // No compare-and-set in the store: write the lease, wait, and refresh only if it still names us.
  async function fresh(stale?: string): Promise<string> {
    const deadline = now() + 2 * LEASE_MS
    for (;;) {
      const t: Tokens | undefined = await store.get(TOKENS)
      if (!t) throw new LoginNeeded()
      if (usable(t, stale)) return t.access_token
      if (now() > deadline) throw new Error('Wispr token refresh: timed out waiting for another session')
      const lease = await store.get(LEASE)
      if (!lease || lease.until <= now() || lease.owner === owner) {
        await store.set(LEASE, { owner, until: now() + LEASE_MS })
        await sleep(SETTLE_MS)
        if ((await store.get(LEASE))?.owner === owner) {
          try {
            return await refresh(stale)
          } finally {
            if ((await store.get(LEASE))?.owner === owner) await store.delete(LEASE)
          }
        }
      }
      await sleep(POLL_MS)
    }
  }

  /** A valid access token. `stale`: a token the server refused, treated as expired. */
  async function accessToken(stale?: string, retried = false): Promise<string> {
    // one refresh per instance at a time: concurrent callers share it
    const token = await (inflight ??= fresh(stale).finally(() => (inflight = undefined)))
    if (stale === undefined || token !== stale) return token
    // the shared run may have been one that did not count `stale` as expired: retry once
    if (retried) throw new Error('Wispr token refresh: the server handed back the refused token')
    return accessToken(stale, true)
  }

  let nextId = 1
  async function rpc(token: string, method: string, params: unknown, sid?: string) {
    const id = method.startsWith('notifications/') ? undefined : nextId++
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
    }
    if (sid) headers['Mcp-Session-Id'] = sid
    const r = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    if (r.status === 401) throw new Unauthorized()
    if (!r.ok) throw new Error(`Wispr MCP ${method}: HTTP ${r.status} ${r.text.slice(0, 200)}`)
    const answer = id === undefined ? undefined : rpcAnswer(r, id)
    if (id !== undefined && !answer) throw new Error(`Wispr MCP ${method}: no answer to request ${id} (HTTP ${r.status}) ${r.text.slice(0, 200)}`)
    if (answer?.error) throw new Error(`Wispr MCP ${method}: ${answer.error.message ?? JSON.stringify(answer.error)}`)
    return { sid: r.headers['mcp-session-id'] ?? sid, result: answer?.result }
  }

  async function session(token: string, tool: string, args: unknown) {
    const init = await rpc(token, 'initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'wisprflow4agents', version: '0' },
    })
    await rpc(token, 'notifications/initialized', undefined, init.sid)
    const { result } = await rpc(token, 'tools/call', { name: tool, arguments: args }, init.sid)
    const text = result?.content?.[0]?.text
    if (result?.isError) throw new Error(`Wispr ${tool}: ${text ?? 'error'}`)
    return result?.structuredContent ?? (text === undefined ? result : JSON.parse(text))
  }

  async function call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
    let token = await accessToken()
    try {
      return await session(token, tool, args)
    } catch (e) {
      if (!(e instanceof Unauthorized)) throw e
    }
    token = await accessToken(token)
    try {
      return await session(token, tool, args)
    } catch (e) {
      throw e instanceof Unauthorized ? new LoginNeeded() : e
    }
  }

  async function logout(): Promise<void> {
    await store.delete(TOKENS)
    await store.delete(CLIENT)
  }

  return { registerClient, authorizeUrl, finishLogin, accessToken, call, logout }
}
