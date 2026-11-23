import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createSession } from '../src/session.mjs'
import { project } from './support.mjs'

const configFor = (projectDir, over = {}) => ({
  projectDir,
  hooks: 'off',
  guards: [],
  shell: null,
  maxOutput: 8000,
  timeoutMs: 600_000,
  spillDir: path.join(os.tmpdir(), `lever-session-test-${process.pid}`),
  ...over,
})

test('values, logs, state and the summary line', async () => {
  const dir = project({ 'a.txt': 'hello\n' })
  const session = createSession(configFor(dir))
  assert.deepEqual(await session.run('1', '1 + 1'), { text: '2', isError: false, file: null })
  assert.equal((await session.run('2', "console.log('first'); console.warn('careful'); ({ n: 5 })")).text, 'first\n[warn] careful\nn: 5')
  await session.run('3', 'state.count = 41')
  assert.equal((await session.run('4', 'state.count + 1')).text, '42')
  const multi = await session.run('5', "const text = await read('a.txt')\nawait write('b.txt', text.toUpperCase())\nconst out = await $`cat b.txt`.text()\nreturn out")
  const [body, footer] = multi.text.split('\n---\n')
  assert.equal(body, 'HELLO')
  assert.match(footer, /^1 read, 1 write, 1 sh · read \d+ B, returned 5 B · \d+ ms\nchanged: b\.txt · undo\(\) puts them back$/)
  assert.equal((await session.run('6', 'undefined')).text, '(done, nothing returned)')
})

test('errors name the line; refusals and failures show in the summary', async () => {
  const dir = project({ 'guard.mjs': "export default step => step.tool === 'Read' && step.input.file_path.endsWith('.env') ? 'no secrets' : null" })
  const session = createSession(configFor(dir, { guards: [path.join(dir, 'guard.mjs')] }))
  const failed = await session.run('1', "const x = 1\nawait $`echo oops >&2; exit 3`")
  assert.equal(failed.isError, true)
  assert.match(failed.text, /^ShellError: Command failed \(exit 3\): echo oops >&2; exit 3\noops\n  at line 2: await \$`echo oops >&2; exit 3`/)
  assert.match(failed.text, /failed: sh echo oops >&2; exit 3 \(3\)/)
  const syntax = await session.run('2', 'const a = 1\nconst = 2')
  assert.equal(syntax.isError, true)
  assert.match(syntax.text, /^SyntaxError: .*\n  at line 2: const = 2/)
  const refused = await session.run('3', "await read('.env')")
  assert.match(refused.text, /^StepRefused: Refused Read \.env: no secrets/)
  assert.match(refused.text, /refused: read \.env/)
  const quiet = await session.run('4', '(await $`exit 1`.nothrow()).exitCode')
  assert.equal(quiet.text.split('\n---\n')[0], '1')
  assert.doesNotMatch(quiet.text, /failed:/)
})

test('stop ends a run and what it started; jobs carry detached runs', async () => {
  const session = createSession(configFor(project()))
  const started = Date.now()
  const pending = session.run('1', "await $`sleep 5`; 'never'")
  setTimeout(() => session.stop('1', 'timeout after 0.1 s'), 100)
  const stopped = await pending
  assert.equal(stopped.isError, true)
  assert.match(stopped.text, /^Stopped: timeout after 0\.1 s/)
  assert.ok(Date.now() - started < 3000)

  const job = session.run('2', "await sleep(150); 'late result'")
  session.detach('2')
  assert.deepEqual(session.jobs.list().map(j => [j.id, j.status]), [['2', 'running']])
  assert.equal((await session.run('3', 'await jobs.wait(2)')).text, 'late result')
  await job
  assert.match((await session.run('4', 'await jobs.wait(99)')).text, /No job 99/)
})

test('undo across runs, long replies saved to a file, imports and promises in values', async () => {
  const dir = project({ 'keep.txt': 'v1\n' })
  const session = createSession(configFor(dir, { maxOutput: 500 }))
  await session.run('1', "await edit('keep.txt', 'v1', 'v2')")
  assert.equal(readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'v2\n')
  const undone = await session.run('2', 'await undo()')
  assert.match(undone.text, /restored: \["keep\.txt"\]/)
  assert.equal(readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'v1\n')
  const long = await session.run('3', "'x'.repeat(3000)")
  assert.ok(long.text.length < 700)
  assert.ok(long.file && existsSync(long.file))
  assert.match(long.text, /full text: /)
  assert.equal((await session.run('4', "import { basename } from 'node:path'\nbasename('/a/b.txt')")).text, 'b.txt')
  assert.equal((await session.run('5', '({ a: Promise.resolve(1), b: sleep(5).then(() => 2) })')).text, 'a: 1\nb: 2')
  // file text comes back exactly, so it can go into edit() as it is
  assert.equal((await session.run('6', "({ n: 1, text: await read('keep.txt') + '  indented\\n' })")).text.split('\n---\n')[0], 'n: 1\n==> text <==\nv1\n  indented')
})

test('mistakes that code written for other tools makes get a hint or a note', async () => {
  const session = createSession(configFor(project({ 'a.txt': 'x\n' })))
  const text = async (id, code) => (await session.run(id, code)).text
  assert.match(await text('1', "const ls = await ls('.')\nls"), /Cannot access 'ls' before initialization\n {2}at line 1.*\n {2}hint: "ls" is a helper, and a const or let with the same name hides it/)
  await session.run('2', 'const found = [1, 2, 3]\nconst { a: renamed, b = 2 } = { a: 1 }\nfound.length')
  assert.match(await text('3', 'found.length'), /found is not defined\n.*\n {2}hint: "found" was declared in an earlier run\. Each run has its own scope: keep values for later runs on state \(state\.found = …\)/)
  assert.match(await text('4', 'renamed'), /hint: "renamed" was declared in an earlier run/)
  assert.doesNotMatch(await text('5', 'neverDeclared'), /hint:/)
  assert.match(await text('6', 'await $`true`.pipe(x => x)'), /is not a function\n.*\n {2}hint: \$ chains \.nothrow\(\) \.cwd\(dir\)/)
  assert.equal(await text('7', 'const kept = 1'), '(done, nothing returned: the code ends with a declaration. End with the value, or return it, to see a result.)')
  assert.equal(await text('8', 'state.n = 1; void 0'), '(done, nothing returned)')
  assert.equal(await text('8b', "['a', 'b'].filter(line => /^#/.test(line)).join('\\n')"), '(done: the code returned an empty string)')
  const unread = await text('9', "exists('a.txt') ? 'yes' : 'no'")
  assert.match(unread, /^yes\n---\nnote: exists\('a\.txt'\) was called without await, so the result was never read \(a promise is always truthy\)\. Write: await exists\(path\)$/)
  assert.equal(await text('10', "(await exists('a.txt')) ? 'yes' : 'no'"), 'yes')
})

test('an error from two lines read as one expression says how to fix it', async () => {
  const session = createSession(configFor(project()))
  const reply = await session.run('1', "const items = [1, 2].map(n => n * 2)\n({ items })")
  assert.equal(reply.isError, true)
  assert.match(reply.text, /hint: line 2 starts with "\(" and the line before has no ";"/)
})

test('a long string inside a returned object is cut only when the reply would be too long; the file keeps all of it', async () => {
  const session = createSession(configFor(project(), { maxOutput: 1000 }))
  const fits = await session.run('1', "({ log: 'a'.repeat(700) + 'END' })")
  assert.match(fits.text, /a{700}END/)
  assert.equal(fits.file, null)
  const long = await session.run('2', "({ log: 'b'.repeat(5000) + 'END' })")
  assert.ok(long.text.length < 1200)
  assert.ok(long.text.includes('END'))
  assert.match(long.text, /full text: /)
  assert.ok(readFileSync(long.file, 'utf8').includes(`${'b'.repeat(5000)}END`))
})
