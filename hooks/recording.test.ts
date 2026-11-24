import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileBase, findArgv, freeArgv, parseFound } from './recording.ts'

const ID = '0a1b2c3d-0000-4000-8000-000000000001'

/** Runs an argv with HOME at `home`, as the mod's spawn would on the machine that has the app. */
const sh = (argv: string[], home: string) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } })

test('the script finds upload.ogg, copies it into Downloads, never over an existing file', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wispr-rec-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const dir = join(home, 'Library/Application Support/Wispr Flow/meetings', ID)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(home, 'Downloads'))
  writeFileSync(join(dir, 'upload.ogg'), 'x'.repeat(1234))
  const copies = [1, 2, 3].map(() => (parseFound(sh(findArgv(ID, 'Weekly-sync-2026-11-20', ''), home).stdout) as any).copy)
  assert.deepEqual(copies, ['', '-2', '-3'].map((n) => join(home, `Downloads/Weekly-sync-2026-11-20${n}.ogg`)))
  const f = parseFound(sh(findArgv(ID, 'Weekly-sync-2026-11-20', '-'), home).stdout) as any
  assert.equal(f.path, join(dir, 'upload.ogg'))
  assert.equal(f.size, 1234)
  assert.ok(Math.abs(f.mtime - Date.now()) < 60_000)
  assert.equal(f.copy, undefined) // '-': no copy
  assert.equal(readdirSync(join(home, 'Downloads')).length, 3)
  assert.equal(sh(freeArgv(join(home, 'Downloads'), 'Weekly-sync-2026-11-20', 'ogg'), home).stdout, join(home, 'Downloads/Weekly-sync-2026-11-20-4.ogg') + '\n')
  rmSync(join(dir, 'upload.ogg'))
  writeFileSync(join(dir, 'mic.pcm'), 'y')
  assert.match(sh(findArgv(ID, 'b', '-'), home).stdout, /^path=.*\/mic\.pcm\n/) // no upload.ogg: the raw file
  assert.deepEqual(parseFound(sh(findArgv(ID.replace('1', '2'), 'b', ''), home).stdout), { none: join(home, 'Library/Application Support/Wispr Flow/meetings', ID.replace('1', '2')) })
})

test('only a UUID builds a command, and a title becomes a safe file name', () => {
  for (const bad of ['m1', `${ID}; rm -rf ~`, '../x', `'${ID}'`]) assert.throws(() => findArgv(bad, 'b', '', 'laptop'), /not a Wispr meeting id/)
  assert.equal(fileBase('Q3 plan: A/B & more?', '2026-11-20T15:00:00Z'), 'Q3-plan-A-B-more-2026-11-20')
  assert.equal(fileBase('회의 Café: plan', '2026-11-20T15:00:00Z'), '회의-Café-plan-2026-11-20') // letters of any script stay
  assert.equal(fileBase('../..', undefined), 'meeting')
})
