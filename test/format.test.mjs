import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { capReply, render, renderWithin, settle, shellText, toPlain } from '../src/format.mjs'

const shell = (over = {}) => ({ __lever: 'shell', command: 'npm test', exitCode: 0, signal: null, stdout: 'ok\n', stderr: '', ...over })

test('renders values the way a person would want to read them', () => {
  assert.equal(render(undefined), '')
  assert.equal(render('plain text'), 'plain text')
  assert.equal(render(42), '42')
  assert.equal(render([1, 'a', true]), '[1,"a",true]')
  assert.equal(render({ edited: 'src/a.ts', count: 2 }), 'edited: src/a.ts\ncount: 2')
  assert.equal(render({ out: 'line 1\nline 2' }), 'out:\n  line 1\n  line 2')
  assert.equal(render([{ f: 'a', n: 1 }, { f: 'b', n: 2 }]), '(2 items)\n{"f":"a","n":1}\n{"f":"b","n":2}')
  assert.equal(render(shell()), 'ok')
  assert.equal(render(new Map([['k', 1]])), 'k: 1')
})

test('failed commands show status, stderr, then stdout', () => {
  const text = shellText(shell({ exitCode: 1, stdout: 'partial', stderr: 'boom' }))
  assert.equal(text, 'exit 1: npm test\nboom\npartial')
})

test('long strings, long arrays and cycles are cut', () => {
  const big = toPlain({ s: 'x'.repeat(5000), a: Array.from({ length: 300 }, (_, i) => i) }, { maxString: 100, maxItems: 10 })
  assert.ok(big.s.startsWith('xxx') && big.s.endsWith('xxx') && big.s.length <= 110)
  assert.match(big.s, /…\[\d+ chars cut\]…/)
  assert.equal(big.a.length, 11)
  const loop = { name: 'a' }
  loop.self = loop
  assert.equal(toPlain(loop).self, '[Circular]')
})

test('settle waits for promises inside the returned value', async () => {
  const value = await settle({ a: Promise.resolve(1), b: [Promise.resolve(2)], c: Promise.reject(new Error('no')) })
  assert.equal(value.a, 1)
  assert.equal(value.b[0], 2)
  assert.equal(value.c.message, 'no')
})

test('capReply cuts the middle and saves the full text', () => {
  const dir = path.join(os.tmpdir(), `lever-format-${process.pid}`)
  const text = `${'a'.repeat(5000)}MIDDLE${'b'.repeat(5000)}`
  const { text: cut, file } = capReply(text, { maxOutput: 1000, spillDir: dir, label: 'run-1' })
  assert.ok(cut.length < 1200)
  assert.ok(cut.startsWith('aaa') && cut.endsWith('bbb'))
  assert.ok(existsSync(file))
  assert.equal(readFileSync(file, 'utf8'), text)
  assert.equal(capReply('short', { maxOutput: 1000, spillDir: dir, label: 'x' }).file, null)
})

test('renderWithin cuts nothing that fits, and keeps both ends of a long string that does not', () => {
  const report = { exitCode: 1, stdout: `START${'.'.repeat(5000)}END` }
  const roomy = renderWithin(report, 8000)
  assert.equal(roomy.text, roomy.whole)
  assert.match(roomy.text, /START\.{5000}END/)
  const tight = renderWithin(report, 1000)
  assert.ok(tight.text.length <= 1000)
  assert.ok(tight.text.includes('START') && tight.text.includes('END'))
  assert.ok(tight.whole.includes(`${'.'.repeat(5000)}END`))
  // lists too: a list that fits is shown whole; a longer one is shortened, and `whole` keeps every item
  const paths = Array.from({ length: 300 }, (_, i) => `src/file-${i}.mjs`)
  const listed = renderWithin(paths, 8000)
  assert.equal(listed.text, listed.whole)
  assert.ok(listed.text.endsWith('src/file-299.mjs'))
  const many = Array.from({ length: 3000 }, (_, i) => `src/file-${i}.mjs`)
  const shortened = renderWithin(many, 8000)
  assert.ok(shortened.text.length <= 8000)
  assert.match(shortened.text, /\n…\+\d+ more$/)
  assert.ok(shortened.whole.endsWith('src/file-2999.mjs'))
})
