import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// node strips types from .ts only; register.tsx holds no JSX, so load it as TypeScript
registerHooks({
  load: (url, ctx, next) => (url.endsWith('.tsx') ? { ...next(url, { ...ctx, format: 'module-typescript' }), format: 'module-typescript' } : next(url, ctx)),
})
const { register } = await import('./register.tsx')

const FOLDER = '[Team] Standup'
const FIXTURE = { list_folders: { folders: [{ id: 'f1', name: FOLDER }] }, list_folder_meetings: {} }

/** The mod wired to a fake `$` in its acceptance mode (WISPRFLOW4AGENTS_FAKE: a fixture, never Wispr). */
async function mod(spawn?: (argv: string[]) => unknown) {
  const hooks: Record<string, any> = {}
  const on = (event: string, a: any, b?: any) => {
    hooks[b ? `${event}:${a.skill}` : event] = b ?? a
    return { catch: () => {} }
  }
  register(on as any, {} as any)
  const data = new Map<string, unknown>([['fake:tokens', { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 86_400_000 }]])
  const toasts: string[] = []
  const submits: string[] = []
  const timer = { cancel() {} }
  const $ = {
    env: { get: async (k: string) => ({ WISPRFLOW4AGENTS_FAKE: '/fixture.json', HOME: '/home/x' })[k] },
    store: { get: async (k: string) => data.get(k), set: async (k: string, v: unknown) => void data.set(k, v), delete: async (k: string) => void data.delete(k), keys: async () => [...data.keys()] },
    fs: { read: async () => JSON.stringify(FIXTURE) },
    clock: { sleep: async () => {}, every: () => timer, after: () => timer },
    ui: { toast: (t: string) => void toasts.push(t) },
    prompt: { submit: async ({ text }: { text: string }) => void submits.push(text) },
    process: { spawn: ({ argv }: { argv: string[] }) => spawn?.(argv) },
    session: { id: async () => 's1', root: async () => '/r' },
  }
  await hooks['session.start']($, {}, async () => ({}))
  const submit = (text: string, kind = 'composer', command?: { name: string; args: string }) =>
    hooks['prompt.submit']($, { origin: { kind }, text, ...(command && { command }) }, async () => ({}))
  // what the engine hands skill.prompt: the SKILL.md body with $ARGUMENTS substituted
  const skill = async (verb: string, args = '') =>
    (await hooks[`skill.prompt:wisprflow4agents:${verb}`]($, { skill: `wisprflow4agents:${verb}`, text: `Base directory for this skill: /x\n\nbody\n\nArguments: ${args}\n` })).text as string
  const turnEnd = (agentId?: string) => hooks['turn.complete']($, { reason: 'answer', ...(agentId && { agentId }) }, async () => ({ text: '' }))
  return { submit, skill, turnEnd, data, toasts, submits }
}

test('a typed plain-language prompt naming Wispr lets the model run watch with its own args, once', async () => {
  const m = await mod()
  await m.submit(`watch ${FOLDER} in wispr please`)
  assert.match(await m.skill('watch', FOLDER), new RegExp(`Watching folder "\\[Team\\] Standup"`))
  assert.match(await m.skill('watch', FOLDER), /^Refused/) // single use
  assert.deepEqual(m.data.get('fake:folders'), [FOLDER]) // a folder lookup caches the names
})

test('a typed prompt naming a cached folder, without "Wispr", grants it; the turn end revokes it', async () => {
  const m = await mod()
  m.data.set('fake:folders', [FOLDER])
  await m.submit(`keep an eye on ${FOLDER.toLowerCase()}`)
  await m.turnEnd('agent-1') // a subagent's end leaves the main turn's permit
  assert.match(await m.skill('watches'), /No watches in this session/)
  await m.turnEnd()
  assert.match(await m.skill('check', FOLDER), /^Refused/)
})

test('no plain-language grant from another origin, a slash command, an unrelated prompt, or for logout', async () => {
  const m = await mod()
  await m.submit('check my wispr notes', 'peer')
  await m.submit('check my wispr notes', 'plugin')
  await m.submit('what is new?')
  assert.match(await m.skill('check'), /^Refused/) // a model call with no such prompt
  await m.submit('log me out of wispr')
  assert.match(await m.skill('logout'), /^Refused/)
  await m.submit('/wisprflow4agents:logout', 'composer', { name: 'wisprflow4agents:logout', args: '' })
  assert.match(await m.skill('logout'), /Signed out/) // typed: still works
})

test('the login listener reports its result to the session as a prompt, and toasts it', async () => {
  let state = ''
  const m = await mod((argv) => {
    state = argv.at(-2)!
    const out = [`listening\n`, `callback code=c1&state=${state}\n`]
    return { next: async () => (out.length ? { done: false, value: { stream: 'stdout', text: out.shift() } } : { done: true }), return: async () => ({ done: true }) }
  })
  await m.skill('login')
  for (let i = 0; i < 50 && !m.submits.length; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(state)
  assert.match(m.submits[0], /^Notice from the wisprflow4agents plugin.*Signed in to Wispr Flow\. Folders: \[Team\] Standup\./)
  assert.ok(m.toasts.includes(`Signed in to Wispr Flow. Folders: ${FOLDER}.`))
})
