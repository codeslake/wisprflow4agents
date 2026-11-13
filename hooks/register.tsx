import type { Register } from 'claude-code'
import { wispr, LoginNeeded } from './wispr.ts'
import { diff, forget, format, pollAll, pollFolder, prefixed } from './watch.ts'
import { PORT, addressInUse, browserHosts, callbackFromOutput, findCallback, forwardArgv, forwardError, forwardUp, listenerArgvs, loginText, redactCallback } from './login.ts'
import type { Route } from './login.ts'
import { permits } from './permit.ts'
import type { FetchPage, Snapshot, WatchEvent } from './watch.ts'

// The mod: the plugin's skills /wisprflow4agents:<verb> answered at `skill.prompt`, per-session
// watch timers, a poll cache shared by every session on the machine, and the login finish
// (a short-lived loopback listener, or a callback URL pasted into a prompt). Rules measured in
// docs/spike.md:
// - `$` is never passed as an argument, so session.start builds `io` from closures once and
//   everything below goes through it.
// - `skill.prompt` names a skill `wisprflow4agents:<verb>` and carries no origin. A typed skill
//   raises `prompt.submit` (origin, and `command: { name, args }`) before its `skill.prompt`, so
//   that hook grants a short-lived permit (permit.ts); every verb but login answers only with one.
// - A prompt from a timer may submit directly.
// - Timers die with a reload or a new process (session.start re-arms) and survive /clear and
//   in-session resume under a new session id (each tick moves the watches to the current key).

interface Watch {
  name: string // 'all' or the folder's name
  scope: string // 'all' or the folder id
  every: number // ms
  toast: boolean // toast only, no prompt
  armedAt: number
  lastPoll?: number
  lastChange?: number
  error?: string
  seen?: Record<string, string> // `<kind>:<id>` -> modified_at ('' when the listing has none)
}
interface Cache {
  at: number
  snapshot: Snapshot
}
interface Pending {
  url: string
  verifier: string
  state: string
  until: number // ms; the link and every listener for it end here
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const PRUNE_MS = 7 * DAY // a watch key with no poll for this long belongs to a session that is gone
const UNITS: Record<string, number> = { s: 1000, m: MINUTE, h: 60 * MINUTE, d: DAY }
const ALLOWED = ['composer', 'bridge'] // typed at the terminal, or Remote Control
const NS = 'wisprflow4agents:'
const TYPED_ONLY = ['logout', 'watch', 'unwatch', 'watches', 'check'].map((v) => NS + v)
const LOGIN_MS = 15 * MINUTE // how long a sign-in link and its listener live (Wispr's own 5 min start at the click)
const FORWARD_MS = 15_000 // one ssh forward's try, past ConnectTimeout=10 and a slow jump host
const ROUTE_WAIT_MS = 7000 // the login hook waits this long for the forward: hooks have a 10 s budget
const PERMIT_MS = 30_000 // a typed run's skill.prompt follows its prompt.submit within ~0.1 s
const HINT =
  'Wispr Flow (the user\'s meetings, notes and transcripts) is reachable only through slash commands the user types; ' +
  'you cannot run them or read Wispr yourself. Name the one that fits: /wisprflow4agents:check [all|<folder>] [--since 1d] ' +
  '(reads what is new or changed and hands it to you), /wisprflow4agents:watch [all|<folder>] [--every 5m] [--toast], ' +
  '/wisprflow4agents:unwatch [all|<name>], /wisprflow4agents:watches, /wisprflow4agents:logout. ' +
  'The one exception: /wisprflow4agents:login only makes a sign-in link, and you may run it when the user asks to sign in to Wispr.'

const dur = (s: string) => {
  const m = /^(\d+)([smhd])$/.exec(s)
  return m ? Number(m[1]) * UNITS[m[2]] : NaN
}
const human = (ms: number) => {
  for (const u of ['d', 'h', 'm']) if (ms >= UNITS[u] && ms % UNITS[u] === 0) return ms / UNITS[u] + u
  return Math.round(ms / 1000) + 's'
}
const ago = (t: number | undefined, now: number) => (t ? human(Math.max(1000, Math.round((now - t) / 1000) * 1000)) + ' ago' : 'never')
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** `[name words] [--flag value] [--toast]`; the name defaults to 'all'. */
function parse(args: string, valued: string[], bare: string[]) {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const flags: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    const f = words[i].startsWith('--') ? words[i].slice(2) : undefined
    if (f === undefined) rest.push(words[i])
    else if (bare.includes(f)) flags[f] = 'yes'
    else if (valued.includes(f) && words[i + 1]) flags[f] = words[++i]
    else throw new Error(`unknown or incomplete option --${f}`)
  }
  return { name: rest.join(' ') || 'all', flags }
}

const seenOf = (s: Snapshot) => Object.fromEntries(Object.entries(s.items).map(([k, e]) => [k, e.mod ?? '']))
const baseline = (w: Watch): Snapshot | undefined =>
  w.seen && {
    scope: w.scope,
    items: Object.fromEntries(Object.entries(w.seen).map(([k, mod]) => [k, { kind: 'meeting', title: '', mod: mod || undefined }])),
  }

export const register: Register = (on, options) => {
  let io: any // built at session.start; every hook below runs after it
  let timer: { cancel(): void } | undefined
  let curKey: string | undefined
  let busy = false
  let wc: ReturnType<typeof wispr> | undefined
  const typedRuns = permits(Date.now, PERMIT_MS)
  let serving = false // this session's login loop runs
  let tried: string | undefined // the pending login's state this session last spawned a listener for
  let child: { return(v?: unknown): Promise<unknown> } | undefined // its listener, while one runs
  let finishedHere = false
  let finishing: Promise<string> | undefined
  let route: { state: string; route?: Route } | undefined // how the pending login's browser reaches this machine, once known
  let gaveUp: string | undefined // the pending state whose login text went out before the forward's outcome

  // one client per module instance, so concurrent callers here share one token refresh
  const client = () => (wc ??= wispr({ fetch: io.fetch, store: io.store, now: Date.now, sleep: io.sleep }))

  const page = (scope: string): FetchPage => (kind, cursor) =>
    client().call(
      scope !== 'all' ? 'list_folder_meetings' : kind === 'note' ? 'search_scratchpad_notes' : 'search_meetings',
      { ...(scope !== 'all' && { folder_id: scope }), limit: scope === 'all' ? 200 : 50, ...(cursor && { cursor }) },
    )

  // One Wispr poll per scope per `maxAge` on this machine: a session whose watch is due reuses a
  // poll another session made within its interval. maxAge 0 always polls.
  async function poll(scope: string, name: string, maxAge: number): Promise<Cache> {
    const key = 'poll:' + scope
    const old: Cache | undefined = await io.store.get(key)
    if (old && Date.now() - old.at < maxAge) return old
    const snap = scope === 'all' ? await pollAll(page(scope), old?.snapshot) : await pollFolder(page(scope), scope, name)
    const fresh = { at: Date.now(), snapshot: snap }
    await io.store.set(key, fresh)
    return fresh
  }

  async function resolve(name: string): Promise<{ scope: string; name: string }> {
    if (name.toLowerCase() === 'all') return { scope: 'all', name: 'all' }
    const folders: { id: string; name: string }[] = (await client().call('list_folders'))?.folders ?? []
    const f = folders.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!f) throw new Error(`no folder named "${name}". Folders: ${folders.map((x) => x.name).join(', ') || '(none)'}`)
    return { scope: f.id, name: f.name }
  }

  // The store key of this session's watches; moves them when the session id or root changed
  // under a live process, and starts or stops the timer to match.
  async function ensure(): Promise<string> {
    const key = `watches:${await io.root()}:${await io.sid()}`
    if (curKey && curKey !== key) {
      const old: Watch[] = (await io.store.get(curKey)) ?? []
      if (old.length) {
        const mine: Watch[] = (await io.store.get(key)) ?? []
        await io.store.set(key, [...mine, ...old.filter((o) => !mine.some((m) => m.scope === o.scope))])
        await io.store.delete(curKey)
      }
    }
    curKey = key
    const n = ((await io.store.get(key)) ?? []).length
    if (n && !timer) timer = io.every(io.tick, () => void tick().catch((e: unknown) => io.toast(`Wispr watch: ${msg(e)}`)))
    if (!n && timer) {
      timer.cancel()
      timer = undefined
    }
    return key
  }

  async function tick() {
    if (busy) return
    busy = true
    try {
      const key = await ensure()
      const now = Date.now()
      const updates = new Map<number, Partial<Watch>>() // by armedAt
      const wake: WatchEvent[] = []
      const quiet: WatchEvent[] = []
      let login = false
      for (const w of ((await io.store.get(key)) ?? []) as Watch[]) {
        if (now - (w.lastPoll ?? 0) < w.every) continue
        try {
          const c = await poll(w.scope, w.name, w.every)
          const events = diff(baseline(w), c.snapshot)
          ;(w.toast ? quiet : wake).push(...events)
          updates.set(w.armedAt, { lastPoll: c.at, seen: seenOf(c.snapshot), error: undefined, ...(events.length && { lastChange: now }) })
        } catch (e) {
          updates.set(w.armedAt, { lastPoll: now, error: msg(e) })
          if (w.error) continue // one toast per outage
          io.toast(`Wispr watch "${w.name}": ${msg(e)}`)
          if (e instanceof LoginNeeded && !w.toast) login = true
        }
      }
      if (!updates.size) return
      // re-read: a command may have changed the list while the polls ran
      const list: Watch[] = (await io.store.get(key)) ?? []
      for (const w of list) Object.assign(w, updates.get(w.armedAt))
      await io.store.set(key, list)
      const all = [...wake, ...quiet]
      if (all.length) io.toast(format(all).toast)
      const prompt = wake.length
        ? format(wake).prompt
        : login && 'A Wispr Flow watch stopped: login needed. Tell the user; /wisprflow4agents:login makes a new sign-in link.'
      if (prompt) void io.submit(prompt).catch(() => {})
    } finally {
      busy = false
    }
  }

  async function prune() {
    for (const k of (await io.store.keys()) as string[]) {
      if (!k.startsWith('watches:')) continue
      const list: Watch[] = (await io.store.get(k)) ?? []
      if (list.every((w) => Date.now() - (w.lastPoll ?? w.armedAt) > PRUNE_MS)) await io.store.delete(k)
    }
  }

  on('session.start', async ($, e, next) => {
    const fake = await $.env.get('WISPRFLOW4AGENTS_FAKE') // acceptance runs only: serve a fixture file, never Wispr
    const home = await $.env.get('HOME')
    const hosts = browserHosts((await $.env.get('WISPRFLOW4AGENTS_BROWSER_SSH')) || String(options.browser_ssh_host ?? ''))
    const store = { get: (k: string) => $.store.get(k), set: (k: string, v: unknown) => $.store.set(k, v), delete: (k: string) => $.store.delete(k), keys: () => $.store.keys() }
    const ok = (body: unknown) => ({ status: 200, ok: true, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) })
    io = {
      tick: fake ? 1000 : 15_000,
      min: fake ? 1000 : MINUTE,
      fetch: async (url: string, init: { body?: string }) => {
        if (!fake) return $.http.fetch(url, init)
        if (url.endsWith('/oauth2/register')) return ok({ client_id: 'fake-client' })
        if (url.endsWith('/oauth2/token')) return ok({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 259200 })
        const rpc = JSON.parse(init.body ?? '{}')
        if (rpc.id === undefined) return { status: 202, ok: true, headers: {}, text: '' }
        const fixture = JSON.parse(await $.fs.read(fake))
        return ok({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'tools/call' ? { structuredContent: fixture[rpc.params.name] ?? {} } : {} })
      },
      store: fake ? prefixed(store, 'fake:') : store, // a fake run never touches a real login or cache
      sleep: (ms: number) => $.clock.sleep(ms),
      every: (ms: number, fn: () => void) => $.clock.every(ms, fn),
      after: (ms: number, fn: () => void) => $.clock.after(ms, fn),
      toast: (text: string) => $.ui.toast(text),
      submit: (text: string) => $.prompt.submit({ text }),
      // not the session's directory, and no NODE_OPTIONS: nothing of the project's runs in the listener
      spawn: (argv: string[]) => $.process.spawn({ argv, cwd: home, env: { NODE_OPTIONS: '' } }),
      hosts, // where the person's browser runs, reached over ssh (empty: this machine)
      sid: () => $.session.id(),
      root: () => $.session.root(),
    }
    await prune()
    await ensure()
    return next(e)
  })

  // A /clear or an in-session resume keeps this process: pick up the new session's own watches.
  on('session.end', ($, e, next) => {
    if (io && (e.reason === 'clear' || e.reason === 'resume')) io.after(2000, () => void ensure().catch(() => {}))
    return next(e)
  })

  // Login, step 1: a link, kept in the store for LOGIN_MS. A run while one is pending reuses it,
  // so a second session or a second run never kills the link the person is already using.
  async function startLogin(): Promise<Pending> {
    const p: Pending | undefined = await io.store.get('login_pending')
    if (p?.until && p.until - Date.now() > MINUTE) return p
    const a = await client().authorizeUrl()
    await io.store.set('login_pending', { url: a.url, verifier: a.verifier, state: a.state, until: Date.now() + LOGIN_MS })
    await io.sleep(300) // two sessions at once: both go on with the one written last
    return io.store.get('login_pending')
  }

  // Login, step 2 (any path): exchange a callback URL's code for the pending login's tokens.
  // Never throws; answers what happened.
  function finish(url: string): Promise<string> {
    return (finishing ??= (async () => {
      try {
        const p: Pending | undefined = await io.store.get('login_pending')
        if (!p) return 'No Wispr Flow login is in progress (it may have finished already).'
        await client().finishLogin(url, p)
        await io.store.delete('login_pending')
        finishedHere = true
        void child?.return(undefined)
        await forget(io.store) // the account may have changed: no cached note survives a login
        const folders: { name: string }[] = (await client().call('list_folders'))?.folders ?? []
        return `Signed in to Wispr Flow. Folders: ${folders.map((f) => f.name).join(', ') || '(none)'}.`
      } catch (err) {
        return `Wispr login failed: ${msg(err)}`
      }
    })().finally(() => (finishing = undefined)))
  }

  // Records how the pending login's browser reaches this machine; a login text that went out
  // before the forward's outcome was known gets it as a notice.
  function noteRoute(state: string, r?: Route) {
    route = { state, route: r }
    if (gaveUp !== state || !r) return
    gaveUp = undefined
    io.toast(
      'via' in r
        ? `Wispr login: the ssh forward to ${r.via} is up. Open the sign-in link in the browser there; nothing to paste.`
        : `Wispr login: no ssh forward to the browser's machine (${'failed' in r ? r.failed.join('; ') : ''}). Open the link on this machine, or paste the callback address here.`,
    )
  }

  // An ssh reverse forward of the callback port to each browser host in turn, until one is
  // accepted; its stream is answered so the listener's end can kill it. Never throws.
  async function openForward(state: string, live: () => boolean) {
    const failed: string[] = []
    for (const host of io.hosts as string[]) {
      if (!live()) return
      const s = io.spawn(forwardArgv(PORT, host))
      let late = false
      const cap = io.after(FORWARD_MS, () => {
        late = true
        void s.return(undefined)
      })
      let err = ''
      try {
        for (let r = await s.next(); !r.done; r = await s.next()) {
          err += r.value.text
          if (!forwardUp(err, PORT)) continue
          if (live()) noteRoute(state, { via: host })
          void (async () => {
            for (let d = await s.next(); !d.done; d = await s.next()); // drain ssh -v until it ends
          })().catch(() => {})
          return s
        }
        failed.push(`${host}: ${late ? `no answer in ${FORWARD_MS / 1000} s` : (forwardError(err) ?? 'ssh ended')}`)
      } catch (e) {
        failed.push(`${host}: ${msg(e)}`) // no ssh installed
      } finally {
        cap.cancel()
      }
    }
    if (live()) noteRoute(state, { failed })
  }

  // One listener for the pending login, until it ends. Answers 'busy' when the port is taken
  // (another session's listener), 'none' when no runtime can listen. A runtime that starts but
  // fails for another reason (a broken install, a stub) gives way to the next one.
  async function listenOnce(p: Pending): Promise<'ended' | 'busy' | 'none'> {
    for (const argv of listenerArgvs(PORT, p.state, (p.until - Date.now()) / 1000)) {
      const s = io.spawn(argv)
      let r
      try {
        r = await s.next()
      } catch {
        continue // this runtime is not installed
      }
      child = s
      let out = ''
      let err = ''
      let live = true
      let fwd: Promise<{ return(v?: unknown): Promise<unknown> } | undefined> | undefined
      // ends the listener once the login ends another way (another session, a paste) or expires
      const t = io.every(2000, () =>
        void io.store.get('login_pending').then((cur: Pending | undefined) => {
          if (cur?.state !== p.state || Date.now() > p.until) void s.return(undefined)
        }),
      )
      try {
        for (; !r.done; r = await s.next()) {
          if (r.value.stream === 'stdout') out += r.value.text
          else err += r.value.text
          if (!fwd && io.hosts.length && out) fwd = openForward(p.state, () => live)
          const url = callbackFromOutput(out)
          if (url) {
            void s.return(undefined)
            io.toast(await finish(url))
            break
          }
        }
      } finally {
        t.cancel()
        child = undefined
        live = false
        void fwd?.then((f) => f?.return(undefined)) // the forward ends with the listener
      }
      if (out) return 'ended' // it ran (`waiting` or `listening`): ended or killed, so no other runtime
      if (addressInUse(err)) return 'busy'
    }
    return 'none'
  }

  // The port is the lock: one listener per machine. A session spawns at most one listener per
  // login attempt (a pending state, or a login run); one that finds the port taken then only
  // reads the store until the login finishes, changes or expires. If the listener's session closes
  // first, nothing listens: the paste path still finishes the login, and a login run retries.
  async function serveLogin() {
    if (serving) return
    serving = true
    finishedHere = false
    const before = (await io.store.get('tokens'))?.access_token
    try {
      for (;;) {
        const p: Pending | undefined = await io.store.get('login_pending')
        if (!p?.until || p.until <= Date.now()) break
        if (p.state !== tried) {
          tried = p.state
          const r = await listenOnce(p)
          if (r !== 'ended') noteRoute(p.state) // another session listens, or none can: no forward from here
          if (r === 'none') break // no python3 or node: the paste path still works
        } else await io.sleep(2000)
      }
      const now = (await io.store.get('tokens'))?.access_token
      if (now && now !== before && !finishedHere) io.toast('Signed in to Wispr Flow.')
    } finally {
      serving = false
    }
  }

  // A typed /wisprflow4agents:<verb> leaves its args for the skill.prompt that follows. A pasted
  // callback URL finishes the login, its code redacted from what the model reads. A prompt naming
  // Wispr gets the command list (the pointer skill alone does not trigger reliably).
  on('prompt.submit', async ($, e, next) => {
    if (!ALLOWED.includes(e.origin.kind)) return next(e)
    const url = findCallback(e.text)
    if (url) {
      const said = await finish(url)
      if (e.command) return { drop: said } // a command's line takes no rewrite: keep the code from the model
      const note = `The user pasted a Wispr Flow login callback URL (its code is redacted here). Result: ${said}`
      return next({ ...e, text: redactCallback(e.text), context: [...(e.context ?? []), note] })
    }
    if (e.command && TYPED_ONLY.includes(e.command.name)) {
      const skill = e.command.name
      typedRuns.grant(skill, e.command.args)
      const r = await next(e)
      if ('drop' in r) typedRuns.revoke(skill) // dropped below: no skill.prompt follows
      return r
    }
    return !e.command && /wispr/i.test(e.text) ? next({ ...e, context: [...(e.context ?? []), HINT] }) : next(e)
  }).catch(($, e, next) => next(e.command ? e : { ...e, text: redactCallback(e.text) })) // a failed hook never blocks the prompt

  const typed = (skill: string) => typedRuns.take(skill)
  const refuse = (skill: string) => ({
    text: `Refused: only the person runs /${skill}, by typing it. Do not retry it or reach Wispr Flow another way; tell the user to type /${skill} themselves.`,
  })
  const relay = (skill: string, said: string) => ({ text: `Result of /${skill}, typed by the user. Show it to the user as written:\n\n${said}` })

  on('skill.prompt', { skill: 'wisprflow4agents:login' }, async ($, e) => {
    try {
      const p = await startLogin()
      tried = undefined // each login run is a new attempt at the port
      if (route?.state !== p.state || !route.route) route = undefined // only this session's own forward outcome stands
      void serveLogin().catch((err: unknown) => io.toast(`Wispr login: ${msg(err)}`))
      let r: Route | undefined
      if (io.hosts.length) {
        for (let t = 0; t < ROUTE_WAIT_MS && route?.state !== p.state; t += 100) await io.sleep(100)
        if (route?.state === p.state) r = route.route
        else {
          gaveUp = p.state
          r = { opening: io.hosts }
        }
      }
      return { text: loginText(p.url, Math.max(1, Math.round((p.until - Date.now()) / MINUTE)), r) }
    } catch (err) {
      return { text: `Tell the user: Wispr login failed: ${msg(err)}` }
    }
  })

  on('skill.prompt', { skill: 'wisprflow4agents:logout' }, async ($, e) => {
    if (typed(e.skill) === undefined) return refuse(e.skill)
    await client().logout()
    await forget(io.store)
    return relay(e.skill, "Signed out: this machine's Wispr Flow tokens, client registration and cached notes are deleted. Watches stay armed and report \"login needed\".")
  })

  on('skill.prompt', { skill: 'wisprflow4agents:watch' }, async ($, e) => {
    const args = typed(e.skill)
    if (args === undefined) return refuse(e.skill)
    try {
      const { name, flags } = parse(args, ['every'], ['toast'])
      const every = dur(flags.every ?? '5m')
      if (!(every >= io.min && every <= DAY)) throw new Error(`--every takes 1m to 1d, like 5m, 2h (got "${flags.every}")`)
      const s = await resolve(name)
      const c = await poll(s.scope, s.name, every)
      const key = await ensure()
      const list: Watch[] = ((await io.store.get(key)) ?? []).filter((w: Watch) => w.scope !== s.scope)
      list.push({ ...s, every, toast: !!flags.toast, armedAt: Date.now(), lastPoll: c.at, seen: seenOf(c.snapshot) })
      await io.store.set(key, list)
      await ensure()
      return relay(
        e.skill,
        `Watching ${s.name === 'all' ? 'all Wispr Flow notes' : `folder "${s.name}"`} every ${human(every)}` +
          `${flags.toast ? ', toast only' : ''}. ${Object.keys(c.snapshot.items).length} notes known; changes from now on are reported.`,
      )
    } catch (err) {
      return relay(e.skill, `Not watching: ${msg(err)}`)
    }
  })

  on('skill.prompt', { skill: 'wisprflow4agents:unwatch' }, async ($, e) => {
    const args = typed(e.skill)
    if (args === undefined) return refuse(e.skill)
    const name = args.trim().toLowerCase() || 'all'
    const key = await ensure()
    const list: Watch[] = (await io.store.get(key)) ?? []
    const keep = name === 'all' ? [] : list.filter((w) => w.name.toLowerCase() !== name)
    await io.store.set(key, keep)
    await ensure()
    return relay(e.skill, `Removed ${list.length - keep.length} watch(es); ${keep.length} left.`)
  })

  on('skill.prompt', { skill: 'wisprflow4agents:watches' }, async ($, e) => {
    if (typed(e.skill) === undefined) return refuse(e.skill)
    const list: Watch[] = (await io.store.get(await ensure())) ?? []
    if (!list.length) return relay(e.skill, 'No watches in this session.')
    const now = Date.now()
    return relay(
      e.skill,
      list
        .map(
          (w) =>
            `${w.name}: every ${human(w.every)}${w.toast ? ', toast only' : ''}; last poll ${ago(w.lastPoll, now)}; ` +
            `last change ${ago(w.lastChange, now)}${w.error ? `; error: ${w.error}` : ''}`,
        )
        .join('\n'),
    )
  })

  on('skill.prompt', { skill: 'wisprflow4agents:check' }, async ($, e) => {
    const args = typed(e.skill)
    if (args === undefined) return refuse(e.skill)
    try {
      const { name, flags } = parse(args, ['since'], [])
      const since = dur(flags.since ?? '1d')
      if (!(since > 0)) throw new Error(`--since takes a duration like 1d, 6h, 30m (got "${flags.since}")`)
      const s = await resolve(name)
      const c = await poll(s.scope, s.name, 0)
      const from = Date.now() - since
      const events: WatchEvent[] = Object.entries(c.snapshot.items)
        .filter(([, x]) => x.when && Date.parse(x.when) >= from)
        .sort(([, a], [, b]) => (b.when! > a.when! ? 1 : -1))
        .map(([k, x]) => ({ ...x, kind: x.mod ? 'changed' : 'new', id: k.slice(k.indexOf(':') + 1) }))
      const where = s.name === 'all' ? 'Wispr Flow' : `Wispr Flow folder "${s.name}"`
      if (!events.length) return relay(e.skill, `Nothing new or changed in ${where} in the last ${human(since)}.`)
      return relay(e.skill, `${where}, last ${human(since)}:\n${format(events).prompt}`)
    } catch (err) {
      return relay(e.skill, `Wispr check failed: ${msg(err)}`)
    }
  })
}
