import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { render } from '../src/format.mjs'
import { createSearch, findRipgrep, globRoot, globToRegExp } from '../src/helpers/search.mjs'
import { makeEnv, project } from './support.mjs'

test('glob patterns follow shell rules', () => {
  const re = globToRegExp
  assert.equal(re('*.ts').test('a.ts'), true)
  assert.equal(re('*.ts').test('src/a.ts'), false)
  assert.equal(re('**/*.ts').test('a.ts'), true)
  assert.equal(re('**/*.ts').test('src/x/a.ts'), true)
  assert.equal(re('src/**').test('src/x/a.ts'), true)
  assert.equal(re('src/*.{ts,js}').test('src/a.js'), true)
  assert.equal(re('src/[ab].ts').test('src/b.ts'), true)
  assert.equal(re('src/[!ab].ts').test('src/b.ts'), false)
  assert.equal(re('a?.md').test('ab.md'), true)
  assert.equal(globRoot('src/lib/**/*.ts'), 'src/lib')
  assert.equal(globRoot('*.ts'), '')
  assert.equal(globRoot('/abs/x/*.md'), '/abs/x')
})

const FILES = {
  'top.ts': 'export const top = 1\n',
  'src/a.ts': 'import x from "y"\n// TODO: first\nconst a = 1\nconst b = 2\n// todo: second\nconst c = 3\n',
  'src/deep/b.js': 'function b() {}\n// TODO third\n',
  'node_modules/pkg/index.ts': '// TODO hidden in deps\n',
  '.cache/c.ts': '// TODO hidden folder\n',
  '.gitignore': 'node_modules/\n',
}

for (const kind of ['ripgrep', 'node']) {
  describe(`search with ${kind}`, { skip: kind === 'ripgrep' && !findRipgrep() }, () => {
    const make = () => {
      const env = makeEnv(project(FILES))
      return { env, search: createSearch({ ...env, rg: kind === 'node' ? null : undefined }) }
    }

    test('glob skips hidden and ignored folders and sorts', async () => {
      const { search } = make()
      assert.deepEqual(await search.glob('*.ts'), ['top.ts'])
      assert.deepEqual(await search.glob('**/*.ts'), ['src/a.ts', 'top.ts'])
      assert.deepEqual(await search.glob('src/**/*.{ts,js}'), ['src/a.ts', 'src/deep/b.js'])
      assert.deepEqual(await search.glob('src/a.ts'), ['src/a.ts'])
      assert.deepEqual(await search.glob('**/*.ts', { hidden: true, ignored: true }), ['.cache/c.ts', 'node_modules/pkg/index.ts', 'src/a.ts', 'top.ts'])
    })

    test('grep content with context, then files and counts', async () => {
      const { search, env } = make()
      const hits = await search.grep('TODO', { context: 1 })
      assert.deepEqual(
        hits.map(h => `${h.file}:${h.line}`),
        ['src/a.ts:2', 'src/deep/b.js:2'],
      )
      assert.deepEqual(hits[0].before, ['import x from "y"'])
      assert.deepEqual(hits[0].after, ['const a = 1'])
      assert.equal(render(hits.slice(0, 1)), 'src/a.ts-1-import x from "y"\nsrc/a.ts:2:// TODO: first\nsrc/a.ts-3-const a = 1')
      assert.deepEqual(await search.grep(/todo/i, { files: true }), ['src/a.ts', 'src/deep/b.js'])
      assert.deepEqual(await search.grep('todo', { ignoreCase: true, count: true }), { 'src/a.ts': 2, 'src/deep/b.js': 1 })
      assert.deepEqual(await search.grep('TODO', { path: 'src/deep', glob: '*.js' }).then(h => h.map(m => m.file)), ['src/deep/b.js'])
      assert.deepEqual(await search.grep('nothing-here-at-all'), [])
      assert.ok(env.current.steps.every(step => step.ok))
    })

    test('grep stops at max and says so; a bad pattern throws', async () => {
      const { search, env } = make()
      const hits = await search.grep('const', { max: 2 })
      assert.equal(hits.length, 2)
      assert.ok(env.current.notes.some(note => /stopped at 2 matches/.test(note)))
      await assert.rejects(search.grep('(unclosed'))
    })
  })
}
