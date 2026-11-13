import { test } from 'node:test'
import assert from 'node:assert/strict'
import { permits } from './permit.ts'

const clock = () => {
  let t = 1000
  return { now: () => t, add: (ms: number) => (t += ms) }
}

test('a typed run hands its args to the one skill.prompt that follows', () => {
  const c = clock()
  const p = permits(c.now, 30_000)
  p.grant('check', 'all --since 2d')
  c.add(80)
  assert.equal(p.take('check'), 'all --since 2d')
  assert.equal(p.take('check'), undefined) // used up
  assert.equal(p.take('watch'), undefined) // one skill's permit is not another's
})

test('the latest typed run of a skill replaces an unclaimed one', () => {
  const p = permits(clock().now, 30_000)
  p.grant('check', 'foo')
  p.grant('check', 'bar')
  assert.equal(p.take('check'), 'bar')
  assert.equal(p.take('check'), undefined)
})

test('a permit unclaimed past its time is refused and gone', () => {
  const c = clock()
  const p = permits(c.now, 30_000)
  p.grant('check', 'foo')
  c.add(30_001)
  assert.equal(p.take('check'), undefined)
  c.add(-30_001)
  assert.equal(p.take('check'), undefined)
})

test('a dropped typed run leaves nothing for a later untyped render or typed run', () => {
  const p = permits(clock().now, 30_000)
  p.grant('check', 'DROPME') // a hook below dropped this prompt: no skill.prompt follows
  p.revoke('check')
  assert.equal(p.take('check'), undefined) // e.g. another plugin's $.skill.prompt: refused
  p.grant('check', 'all')
  assert.equal(p.take('check'), 'all') // the next typed run gets its own args, not DROPME
})
