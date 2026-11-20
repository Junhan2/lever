import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createEvaluator, lastStatement, wrapCode } from '../src/evaluate.mjs'

const lastOf = code => {
  const range = lastStatement(code)
  return range ? code.slice(range.start, range.end) : null
}

test('finds the last statement across semicolons and line breaks', () => {
  assert.equal(lastOf('const a = 1\nconst b = 2\na + b'), 'a + b')
  assert.equal(lastOf('const a = 1; a * 2;'), 'a * 2')
  assert.equal(lastOf('foo()\n  .bar()\n  .baz()'), 'foo()\n  .bar()\n  .baz()')
  assert.equal(lastOf('const x = 1\n(x)'), 'const x = 1\n(x)') // a line starting with ( continues the statement
  assert.equal(lastOf('const t = `a ${b + `c ${d}`} e`\nt.length'), 't.length')
  assert.equal(lastOf('const s = "x;y" // a; b\n/* c;\n d */ s'), 's')
  assert.equal(lastOf('const r = /[;"]/g\nr.source'), 'r.source')
  assert.equal(lastOf('if (a) {\n  b()\n} else {\n  c()\n}'), 'if (a) {\n  b()\n} else {\n  c()\n}')
  assert.equal(lastOf('const n = 4 / 2 / 1\nn'), 'n')
  assert.equal(lastOf('   '), null)
})

test('a template literal holding code lines is never split or changed', () => {
  const code = 'const text = `const x = 1\nconst y = 2;\nx + y`\ntext.length'
  assert.equal(lastOf(code), 'text.length')
  assert.ok(wrapCode(code).source.includes('`const x = 1\nconst y = 2;\nx + y`'))
})

test('wraps the last expression in return only when that still compiles', () => {
  assert.equal(wrapCode('1 + 2').returnsLast, true)
  assert.equal(wrapCode('const a = 1').returnsLast, false)
  assert.equal(wrapCode('for (const x of [1]) {}').returnsLast, false)
  assert.equal(wrapCode('{ a: 1, b: 2 }').returnsLast, true) // read as an object literal, like the Node REPL does
})

test('runs code: last value, await, return, errors with user line numbers', async () => {
  const { evaluate } = createEvaluator({ double: x => x * 2 })
  assert.equal(await evaluate('1 + 2').promise, 3)
  assert.equal(await evaluate('const v = await Promise.resolve(21)\ndouble(v)').promise, 42)
  assert.equal(JSON.stringify(await evaluate('const a = 1;\n({ a, b: a + 1 });').promise), '{"a":1,"b":2}')
  assert.equal(await evaluate('if (true) return "early"\n"late"').promise, 'early')
  await assert.rejects(evaluate('await null\nthrow new Error("late")').promise, /late/)
  const failing = evaluate('const a = 1\n\nundefinedName + a')
  await assert.rejects(failing.promise, error => /undefinedName/.test(error.message) && error.stack.includes(`${failing.filename}:3`))
  await assert.rejects(evaluate('const = 1').promise, SyntaxError)
})

test('each run has its own scope; state on globalThis survives', async () => {
  const { evaluate } = createEvaluator({ state: {} })
  assert.equal(await evaluate('const files = [1, 2]\nstate.files = files\nfiles.length').promise, 2)
  assert.equal(await evaluate('const files = [1, 2, 3]\nfiles.length').promise, 3) // no clash with the first run
  assert.equal(JSON.stringify(await evaluate('state.files').promise), '[1,2]')
  await evaluate('globalThis.kept = 7').promise
  assert.equal(await evaluate('kept').promise, 7)
})

test('dynamic import and Node globals work inside the context', async () => {
  const { evaluate } = createEvaluator({})
  assert.equal(await evaluate('(await import("node:path")).basename("/a/b.txt")').promise, 'b.txt')
  assert.equal(await evaluate('Buffer.from("hi").toString("base64")').promise, 'aGk=')
  assert.equal(await evaluate('await new Promise(r => setTimeout(() => r("t"), 5))').promise, 't')
})

test('a synchronous endless loop before the first await stops at the timeout', async () => {
  const { evaluate } = createEvaluator({})
  await assert.rejects(evaluate('while (true) {}', { timeoutMs: 50 }).promise, /timed out/i)
})

test('import lines at the top become await import, and packages resolve from dir', async () => {
  const { hoistImports } = await import('../src/evaluate.mjs')
  const out = hoistImports("import fs from 'node:fs'\nimport { join as j, sep } from 'node:path'\nimport * as os from 'node:os'\nimport 'node:util'\nconst x = 1")
  assert.match(out, /^const __import\d+ = await import\("node:fs"\); const fs = __import\d+\.default \?\? __import\d+;\n/)
  assert.match(out, /const \{ join: j, sep \} = __import\d+;/)
  assert.equal(out.split('\n').length, 5)
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lever-import-'))
  mkdirSync(path.join(dir, 'node_modules', 'fakepkg'), { recursive: true })
  writeFileSync(path.join(dir, 'node_modules', 'fakepkg', 'package.json'), '{"name":"fakepkg","type":"module","exports":{".":{"import":"./i.mjs"}}}')
  writeFileSync(path.join(dir, 'node_modules', 'fakepkg', 'i.mjs'), "export const hello = 'hi'")
  const { evaluate } = createEvaluator({}, { dir })
  assert.equal(await evaluate("import { hello } from 'fakepkg'\nimport { basename } from 'node:path'\nhello + basename('/a/b')").promise, 'hib')
})
