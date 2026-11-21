import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createShell, quote } from '../src/helpers/shell.mjs'
import { fakeRun, makeEnv, project } from './support.mjs'

test('quotes values so they stay one argument', () => {
  assert.equal(quote('plain-name.ts'), 'plain-name.ts')
  assert.equal(quote('a b'), "'a b'")
  assert.equal(quote("it's"), "'it'\\''s'")
  assert.equal(quote(''), "''")
})

test('runs a command, quotes interpolated values and records the step', async () => {
  const env = makeEnv(project())
  const $ = createShell(env)
  const result = await $`printf '%s|' ${'a b'} ${['c', "d'e"]}`
  assert.equal(result.stdout, "a b|c|d'e|")
  assert.equal(result.ok, true)
  assert.equal(String(result), "a b|c|d'e|")
  assert.equal(env.current.steps[0].kind, 'sh')
  assert.equal(env.current.steps[0].ok, true)
  assert.equal(await $`echo ${$.raw('$((1+2))')}`.text(), '3')
})

test('a failing command throws, unless nothrow', async () => {
  const $ = createShell(makeEnv(project()))
  await assert.rejects($`echo out; echo bad >&2; exit 3`, error => {
    assert.equal(error.name, 'ShellError')
    assert.match(error.message, /exit 3/)
    // both streams had text, so both ends are in the message (npm test: npm's note on stderr, the report on stdout)
    assert.match(error.message, /stderr \(end\):\nbad\nstdout \(end\):\nout$/)
    return true
  })
  const result = await $`exit 3`.nothrow()
  assert.equal(result.exitCode, 3)
  assert.equal(result.ok, false)
  const lenient = await $({ nothrow: true })`exit 4`
  assert.equal(lenient.exitCode, 4)
})

test('text, lines, json and cwd', async () => {
  const dir = project()
  mkdirSync(path.join(dir, 'sub'))
  const $ = createShell(makeEnv(dir))
  assert.deepEqual(await $`printf 'a\nb\n'`.lines(), ['a', 'b'])
  assert.deepEqual(await $`echo '{"x":1}'`.json(), { x: 1 })
  assert.ok((await $({ cwd: 'sub' })`pwd`.text()).endsWith(`${path.sep}sub`))
  assert.equal(await $('echo whole command').text(), 'whole command')
})

test('timeout and abort stop the command and what it started', async () => {
  const env = makeEnv(project())
  const $ = createShell(env)
  const started = Date.now()
  await assert.rejects($`sleep 5`.timeout(150), /killed by SIGTERM/)
  assert.ok(Date.now() - started < 3000)
  const run = fakeRun('2')
  env.current = run
  const pending = $`sh -c 'sleep 5; echo late'`.nothrow()
  setTimeout(() => run.abort(), 150)
  const result = await pending
  assert.equal(result.signal, 'SIGTERM')
})

test('a guard refusal stops the step even with nothrow', async () => {
  const dir = project({ 'guard.mjs': "export default step => step.input.command?.includes('rm ') ? 'no deleting' : null" })
  const env = makeEnv(dir, { guards: [path.join(dir, 'guard.mjs')] })
  const $ = createShell(env)
  await assert.rejects($`rm -f x`.nothrow(), error => error.name === 'StepRefused' && /no deleting/.test(error.message))
  assert.equal(env.current.steps.at(-1).detail, 'refused')
  assert.equal((await $`echo fine`.text()), 'fine')
})
