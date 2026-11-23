import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createFiles, fingerprint } from '../src/helpers/files.mjs'
import { fakeRun, makeEnv, project } from './support.mjs'

const finish = async (env, run) => {
  const after = new Map()
  for (const file of run.journal.keys()) after.set(file, existsSync(file) ? fingerprint(readFileSync(file)) : null)
  env.history.push({ id: run.id, journal: run.journal, after })
}

test('read, ranges, write and JSON', async () => {
  const dir = project({ 'a.txt': 'one\ntwo\nthree\n' })
  const env = makeEnv(dir)
  const files = createFiles(env)
  assert.equal(await files.read('a.txt'), 'one\ntwo\nthree\n')
  assert.equal(await files.read('a.txt', { from: 2, to: 3 }), 'two\nthree')
  assert.deepEqual(await files.write('out/b.json', { ok: true }), { path: 'out/b.json', bytes: 17 })
  assert.equal(readFileSync(path.join(dir, 'out/b.json'), 'utf8'), '{\n  "ok": true\n}\n')
  assert.equal(await files.exists('out/b.json'), true)
  assert.deepEqual(await files.ls('.'), ['a.txt', 'out/'])
  assert.ok(env.current.bytesIn >= 14)
})

test('edit: one pair, pairs, all, function, and helpful misses', async () => {
  const dir = project({ 'c.ts': 'const a = 1\nconst b = 2\n  if (x) {\n    go()\n  }\nconst a2 = 1\n' })
  const files = createFiles(makeEnv(dir))
  const read = () => readFileSync(path.join(dir, 'c.ts'), 'utf8')
  assert.equal((await files.edit('c.ts', 'const b = 2', 'const b = 3')).replaced, 1)
  await assert.rejects(files.edit('c.ts', '= 1', '= 9'), /found 2 times \(lines 1, 6\)/)
  assert.equal((await files.edit('c.ts', '= 1', '= 9', { all: true })).replaced, 2)
  await assert.rejects(files.edit('c.ts', 'if (x) {\n  go()', 'nope'), /matches if whitespace is ignored/)
  await assert.rejects(files.edit('c.ts', 'const b = 3\nconst zzz', 'nope'), /first line is at line 2/)
  await files.edit('c.ts', [['const a = 9', 'let a = 9'], ['go()', 'stop()']])
  await files.edit('c.ts', text => text.toUpperCase())
  assert.equal(read(), 'LET A = 9\nCONST B = 3\n  IF (X) {\n    STOP()\n  }\nCONST A2 = 9\n')
  const same = await files.edit('c.ts', text => text)
  assert.equal(same.changed, false)
})

test('undo puts files back and never overwrites newer work', async () => {
  const dir = project({ 'keep.txt': 'before\n' })
  const env = makeEnv(dir)
  const files = createFiles(env)
  const runA = fakeRun('A')
  env.current = runA
  await files.edit('keep.txt', 'before', 'after')
  await files.write('new.txt', 'made by A')
  await finish(env, runA)
  env.current = fakeRun('B')
  const undone = await files.undo()
  assert.deepEqual(undone.restored.sort(), ['keep.txt', 'new.txt'])
  assert.equal(readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'before\n')
  assert.equal(existsSync(path.join(dir, 'new.txt')), false)

  const runC = fakeRun('C')
  env.current = runC
  await files.edit('keep.txt', 'before', 'from C')
  await finish(env, runC)
  writeFileSync(path.join(dir, 'keep.txt'), 'someone else changed it\n')
  env.current = fakeRun('D')
  const skipped = await files.undo('C')
  assert.deepEqual(skipped.skipped, ['keep.txt'])
  assert.equal(readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'someone else changed it\n')
  assert.equal((await files.undo()).note, 'nothing to undo')
})

test('a guard can keep a path away', async () => {
  const dir = project({ 'secret.txt': 'x', 'fine.txt': 'y', 'guard.mjs': "export default step => String(step.input.file_path ?? '').includes('secret') ? 'kept away' : null" })
  const env = makeEnv(dir, { guards: [path.join(dir, 'guard.mjs')] })
  const files = createFiles(env)
  await assert.rejects(files.read('secret.txt'), /kept away/)
  await assert.rejects(files.write('secret.txt', 'z'), /kept away/)
  assert.equal(readFileSync(path.join(dir, 'secret.txt'), 'utf8'), 'x')
  assert.equal(await files.read('fine.txt'), 'y')
})
