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
  // a grep match or a write result stands for its file
  assert.equal(await files.read({ file: 'a.txt', line: 2, text: 'two' }, { from: 2, to: 2 }), 'two')
  // exists without await is a promise, which is always truthy: the run keeps the call so the reply can say so
  assert.equal(env.current.loose.size, 0)
  assert.equal(files.exists('nothing-here.txt') ? 'always' : 'never', 'always')
  assert.deepEqual([...env.current.loose].map(call => call.label), ["exists('nothing-here.txt')"])
})

test('edit: one pair, pairs, all, function, and helpful misses', async () => {
  const dir = project({ 'c.ts': 'const a = 1\nconst b = 2\n  if (x) {\n    go()\n  }\nconst a2 = 1\n' })
  const files = createFiles(makeEnv(dir))
  const read = () => readFileSync(path.join(dir, 'c.ts'), 'utf8')
  assert.equal((await files.edit('c.ts', 'const b = 2', 'const b = 3')).replaced, 1)
  await assert.rejects(files.edit('c.ts', '= 1', '= 9'), /found 2 times \(lines 1, 6\)/)
  assert.equal((await files.edit('c.ts', '= 1', '= 9', { all: true })).replaced, 2)
  await assert.rejects(files.edit('c.ts', '  if (x) {\n  go()\n  }', 'nope'), /matches if whitespace is ignored/) // lines moved unevenly
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

test('edit finds text given with more or less indentation, moves the new text the same way, and says so', async () => {
  const dir = project({ 'r.mjs': 'function tier(n) {\n  if (n > 2) return 1\n  return 0\n}\nfunction other(n) {\n  return 0\n}\n', 'crlf.txt': 'alpha\r\n  beta\r\n' })
  const env = makeEnv(dir)
  const files = createFiles(env)
  const read = () => readFileSync(path.join(dir, 'r.mjs'), 'utf8')
  await files.edit('r.mjs', '    if (n > 2) return 1', '    if (n >= 2) return 1')
  assert.ok(read().includes('\n  if (n >= 2) return 1\n'))
  assert.ok(env.current.notes.some(note => /indented 2 spaces less than given/.test(note)))
  await files.edit('r.mjs', 'function tier(n) {\nif (n >= 2) return 1', 'function tier(n) {\nif (n === 1) return 2\nif (n >= 2) return 1')
  assert.ok(read().startsWith('function tier(n) {\n  if (n === 1) return 2\n  if (n >= 2) return 1\n  return 0\n'))
  await assert.rejects(files.edit('r.mjs', '    return 0', 'x'), /text not found/) // two places fit
  await files.edit('crlf.txt', 'alpha\n  beta', 'ALPHA\n  BETA')
  assert.equal(readFileSync(path.join(dir, 'crlf.txt'), 'utf8'), 'ALPHA\r\n  BETA\r\n')
})

test('changes to one file that start together all land; an edit function cannot change its own file', async () => {
  const dir = project({ 'same.txt': 'a b c d e\n' })
  const files = createFiles(makeEnv(dir))
  await Promise.all([files.edit('same.txt', 'a', 'A'), files.edit('same.txt', 'c', 'C'), files.write('other.txt', '1'), files.edit('same.txt', 'e', 'E')])
  assert.equal(await files.read('same.txt'), 'A b C d E\n')
  await assert.rejects(
    files.edit('same.txt', text => files.write('same.txt', 'x').then(() => text)),
    /already being changed by the edit function/,
  )
  assert.equal((await files.edit('same.txt', 'A', 'a')).changed, true) // the file is not left locked
})

test('file errors say what to try next', async () => {
  const files = createFiles(makeEnv(project({ 'settings.json': '{}', 'src/a.mjs': 'x\n' })))
  await assert.rejects(files.read('src'), /read\(src\): that is a folder\. List it with ls\('src'\)/)
  await assert.rejects(files.read('setting.json'), /read\(setting\.json\): no such file\. Close names in .*: settings\.json/)
  await assert.rejects(files.edit('src/A.MJS.bak', 'x', 'y'), /no such file/)
  await assert.rejects(files.read('nowhere/x.txt'), /the folder nowhere does not exist/)
  await assert.rejects(files.ls('settings.json'), /that is a file\. Read it with read\('settings\.json'\)/)
  await assert.rejects(files.edit(undefined, 'a', 'b'), /edit\(path\): the path must be a non-empty string, got undefined/)
  assert.equal((await files.read('missing.txt').catch(error => error.code)), 'ENOENT') // code is kept for code that checks it
})
