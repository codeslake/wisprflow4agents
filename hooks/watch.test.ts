import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diff, forget, format, pollAll, pollFolder, prefixed, newestModified, KEEP } from './watch.ts'
import type { FetchPage, KeyStore, Page, Snapshot } from './watch.ts'

const m = (id: string, mod: string, title = 'T ' + id) => ({ id, title, modified_at: mod, share_link: 'https://example.test/' + id })

// pages: per kind, a list of pages; the cursor is the page index as a string.
function fake(pages: Record<string, Page[]>): FetchPage & { calls: string[] } {
  const f = (async (kind: string, cursor?: string) => {
    f.calls.push(`${kind}:${cursor ?? ''}`)
    return pages[kind][cursor ? Number(cursor) : 0] ?? { has_more: false }
  }) as FetchPage & { calls: string[] }
  f.calls = []
  return f
}

const snap = (items: Snapshot['items'], scope = 'all'): Snapshot => ({ scope, items })
const e = (mod?: string, title = 'x') => ({ kind: 'meeting' as const, title, mod })

test('baseline yields no events', async () => {
  const next = await pollAll(fake({ meeting: [{ meetings: [m('a', '2026-11-01T00:00:00Z')] }], note: [{ notes: [] }] }))
  assert.deepEqual(diff(undefined, next), [])
  assert.deepEqual(Object.keys(next.items), ['meeting:a'])
})

test('new id and moved modified_at give events, removal is silent', () => {
  const prev = snap({ 'meeting:a': e('1'), 'meeting:b': e('1'), 'meeting:gone': e('1') })
  const next = snap({ 'meeting:a': e('1'), 'meeting:b': e('2'), 'meeting:c': e('3', 'new one') })
  const ev = diff(prev, next)
  assert.deepEqual(ev.map((x) => [x.kind, x.id]), [['changed', 'b'], ['new', 'c']])
})

test('filing into a folder shows as new membership', async () => {
  const f = fake({ meeting: [{ meetings: [{ id: 'a', title: 'A', created_at: '2026-11-01T00:00:00Z' }] }] })
  const next = await pollFolder(f, 'f1', 'Folder One')
  const ev = diff(snap({}, 'f1'), next)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].kind, 'new')
  assert.equal(ev[0].folder, 'Folder One')
  assert.deepEqual(diff(next, next), [])
})

test('scope change is a baseline', () => {
  assert.deepEqual(diff(snap({}, 'f1'), snap({ 'meeting:a': e() }, 'all')), [])
})

test('paging stops at the first item older than the last poll', async () => {
  const prev = snap({ 'meeting:old': e('2026-11-05T00:00:00Z') })
  const f = fake({
    meeting: [
      { meetings: [m('n1', '2026-11-09T00:00:00Z'), m('n2', '2026-11-05T00:00:00Z'), m('o', '2026-11-04T00:00:00Z')], has_more: true, next_cursor: '1' },
      { meetings: [m('never', '2026-11-01T00:00:00Z')] },
    ],
    note: [{ notes: [] }],
  })
  const next = await pollAll(f, prev)
  assert.deepEqual(f.calls, ['meeting:', 'note:'])
  assert.deepEqual(Object.keys(next.items).sort(), ['meeting:n1', 'meeting:n2', 'meeting:old'])
  assert.equal(newestModified(next), '2026-11-09T00:00:00Z')
})

test('paging follows the cursor until has_more is false', async () => {
  const f = fake({
    meeting: [
      { meetings: [m('a', '3')], has_more: true, next_cursor: '1' },
      { meetings: [m('b', '2')], has_more: false },
    ],
    note: [{ notes: [] }],
  })
  const next = await pollAll(f)
  assert.deepEqual(f.calls, ['meeting:', 'meeting:1', 'note:'])
  assert.equal(Object.keys(next.items).length, 2)
})

test('paging is capped at 1000 items', async () => {
  let pages = 0
  const f: FetchPage = async (kind, cursor) =>
    kind === 'note'
      ? { notes: [] }
      : (pages++, {
          meetings: Array.from({ length: 200 }, (_, i) => m(`${cursor ?? ''}-${i}`, '2026-11-01T00:00:00Z')),
          has_more: true,
          next_cursor: (cursor ?? '') + 'z',
        })
  const next = await pollAll(f)
  assert.equal(pages, 5)
  assert.equal(Object.keys(next.items).length, KEEP)
})

const iso = (min: number) => new Date(Date.UTC(2026, 10, 10, 10, 0) + min * 60_000).toISOString()

test('paging re-reads 10 minutes below the stop mark: a late item shows, a re-read one does not repeat', async () => {
  const prev = snap({ 'meeting:old': e(iso(0)) }) // stop mark 10:00
  const f = fake({
    meeting: [
      { meetings: [m('n1', iso(5)), m('old', iso(0)), m('late', iso(-5)), m('o', iso(-11)), m('never', iso(-12))] },
    ],
    note: [{ notes: [] }],
  })
  const next = await pollAll(f, prev)
  assert.deepEqual(Object.keys(next.items).sort(), ['meeting:late', 'meeting:n1', 'meeting:old'])
  assert.deepEqual(diff(prev, next).map((x) => [x.kind, x.id]), [['new', 'n1'], ['new', 'late']])
})

test('the stop mark compares times, not strings', async () => {
  // '...00.500Z' sorts below '...00Z' as text but is later in time
  const prev = snap({ 'meeting:a': e('2026-11-10T10:00:00.500Z'), 'meeting:b': e('2026-11-10T10:00:00Z') })
  assert.equal(newestModified(prev), '2026-11-10T10:00:00.500Z')
})

test('an all snapshot keeps only the newest 500 entries', async () => {
  const items: Snapshot['items'] = {}
  for (let i = 0; i < 600; i++) items['meeting:p' + i] = e(iso(-i))
  const f = fake({ meeting: [{ meetings: [m('fresh', iso(1))] }], note: [{ notes: [{ id: 'nt', created_at: iso(-1000) }] }] })
  const next = await pollAll(f, snap(items))
  const keys = Object.keys(next.items)
  assert.equal(keys.length, KEEP)
  assert.ok(keys.includes('meeting:fresh') && keys.includes('meeting:p0') && keys.includes('meeting:p498'))
  assert.ok(!keys.includes('meeting:p499') && !keys.includes('note:nt'))
})

test('excerpts are clipped to 200 characters when fetched', async () => {
  const f = fake({ meeting: [{ meetings: [{ ...m('a', iso(0)), content_excerpt: 'y'.repeat(500) }] }], note: [{ notes: [] }] })
  assert.equal((await pollAll(f)).items['meeting:a'].excerpt!.length, 200)
})

function memStore(): KeyStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {}
  return {
    data,
    get: async (k) => (k in data ? structuredClone(data[k]) : undefined),
    set: async (k, v) => void (data[k] = structuredClone(v)),
    delete: async (k) => void delete data[k],
    keys: async () => Object.keys(data),
  }
}

test('a prefixed store reads and writes only its own keys', async () => {
  const real = memStore()
  await real.set('tokens', 'live')
  const fakeStore = prefixed(real, 'fake:')
  assert.equal(await fakeStore.get('tokens'), undefined)
  await fakeStore.set('tokens', 'fixture')
  await fakeStore.set('client', 'fake-client')
  assert.equal(await real.get('tokens'), 'live')
  assert.deepEqual(await fakeStore.keys(), ['tokens', 'client'])
  await fakeStore.delete('tokens')
  assert.deepEqual(real.data, { tokens: 'live', 'fake:client': 'fake-client' })
})

test('forget drops cached polls, every watch baseline and a pending login, and keeps the rest', async () => {
  const s = memStore()
  await s.set('poll:all', { at: 1, snapshot: snap({ 'meeting:a': e('1') }) })
  await s.set('poll:f1', { at: 1, snapshot: snap({}, 'f1') })
  await s.set('login_pending', { verifier: 'v', state: 's' })
  await s.set('tokens', { access_token: 'a' })
  await s.set('watches:/r:s1', [{ name: 'all', scope: 'all', every: 1, seen: { 'meeting:a': '1' } }])
  await s.set('watches:/r:s2', [{ name: 'F', scope: 'f1', every: 1, seen: {} }, { name: 'all', scope: 'all', every: 2 }])
  await forget(s)
  assert.deepEqual(s.data, {
    tokens: { access_token: 'a' },
    'watches:/r:s1': [{ name: 'all', scope: 'all', every: 1 }],
    'watches:/r:s2': [{ name: 'F', scope: 'f1', every: 1 }, { name: 'all', scope: 'all', every: 2 }],
  })
})

test('empty title formats as (untitled) and note text is labelled as data', () => {
  const ev = diff(snap({}), snap({ 'meeting:a': { kind: 'meeting', title: '', mod: '1', excerpt: 'line one\n\nline two', link: 'https://example.test/a' } }))
  const out = format(ev)
  assert.match(out.prompt, /New: \(untitled\)/)
  assert.match(out.prompt, /not instructions/)
  assert.match(out.prompt, /excerpt: line one line two/)
  assert.equal(out.toast, 'Wispr: new note "(untitled)"')
})

test('format of nothing is empty; many events summarise', () => {
  assert.deepEqual(format([]), { prompt: '', toast: '' })
  const ev = diff(snap({}), snap({ 'meeting:a': e('1', 'A'), 'meeting:b': e('1', 'B') }))
  assert.match(format(ev).toast, /^Wispr: 2 notes/)
})

test('the prompt lists at most 20 events, titles clipped to 100 chars, then "and N more"', () => {
  const items: Snapshot['items'] = {}
  for (let i = 0; i < 25; i++) items['meeting:' + i] = e('1', 'x'.repeat(150))
  const out = format(diff(snap({}), snap(items))).prompt
  assert.match(out, /notes changed \(25\)/)
  assert.equal(out.split('\n').filter((l) => l.startsWith('- New: ' + 'x'.repeat(99) + '…')).length, 20)
  assert.ok(!out.includes('x'.repeat(100)))
  assert.match(out, /\n- and 5 more$/)
})
