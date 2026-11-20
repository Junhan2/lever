import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Keep the real user settings (and their rules and hooks) out of these tests.
process.env.CLAUDE_CONFIG_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'lever-home-'))
import { createGuard } from '../src/guard.mjs'
import { createFiles } from '../src/helpers/files.mjs'
import { createSearch } from '../src/helpers/search.mjs'
import { bashPieces, createRules } from '../src/rules.mjs'
import { fakeRun, project } from './support.mjs'

const rulesFor = (permissions, { root = '/proj', cwd = '/proj' } = {}) => createRules([{ file: 'settings.json', root, cwd, data: { permissions } }])

test('shell commands split into the simple commands that rules see', () => {
  assert.deepEqual(bashPieces('cd app && git push origin main'), ['cd app', 'git push origin main'])
  assert.deepEqual(bashPieces('echo "a && b"; ls | wc -l'), ['echo "a && b"', 'ls', 'wc -l'])
  assert.deepEqual(bashPieces('echo "$(git push)" `rm -rf x`'), ['git push', 'rm -rf x', 'echo "$(git push)" `rm -rf x`'])
  assert.deepEqual(bashPieces('timeout 30 nice -n 5 FOO=1 npm test'), ['npm test'])
  assert.deepEqual(bashPieces('NODE_ENV=test npm test'), ['npm test'])
  assert.deepEqual(bashPieces('for f in a b; do rm "$f"; done'), ['for f in a b', 'rm "$f"'])
  assert.deepEqual(bashPieces('(cd x && make)'), ['cd x', 'make'])
  assert.deepEqual(bashPieces('xargs grep foo'), ['grep foo'])
  assert.deepEqual(bashPieces('command -v git'), ['command -v git'])
})

test('Bash rules: wildcards, bare prefixes, compound commands, ask', () => {
  const rules = rulesFor({ deny: ['Bash(git push *)', 'Bash(rm:*)'], ask: ['Bash(npm publish)'] })
  const check = command => rules.check('Bash', { command })?.deny ?? null
  assert.match(check('git push origin main'), /Bash\(git push \*\) in settings\.json refuses/)
  assert.ok(check('git push'))
  assert.ok(check('cd app && git push origin main'))
  assert.ok(check('echo "$(git push)"'))
  assert.ok(check('timeout 30 git push'))
  assert.ok(check('FOO=bar rm -rf build'))
  assert.equal(check('git status'), null)
  assert.equal(check('rmdir x'), null)
  assert.match(check('npm publish'), /wants a person to approve/)
  assert.equal(check('npm publish --dry-run'), null)
  assert.equal(rulesFor({ deny: ['Bash'] }).check('Bash', { command: 'ls' }) !== null, true)
})

test('Read and Edit path rules anchor like the docs say', () => {
  const home = os.homedir()
  const rules = rulesFor({ deny: ['Read(./.env)', 'Read(secrets/**)', 'Edit(/src/**)', 'Read(//etc/shadow)', 'Read(~/.ssh/**)', 'Read(*.key)', 'Read(!public.key)'] })
  const read = file => rules.check('Read', { file_path: file })?.deny ?? null
  assert.ok(read('/proj/.env'))
  assert.ok(read('/proj/sub/.env'))
  assert.equal(read('/proj/.env.example'), null)
  assert.ok(read('/proj/a/secrets/token.txt'))
  assert.ok(read('/etc/shadow'))
  assert.ok(read(path.join(home, '.ssh', 'id_ed25519')))
  assert.ok(read('/proj/x/server.key'))
  assert.equal(read('/proj/x/public.key'), null) // carved out by !public.key
  assert.equal(read('/proj/src/a.ts'), null)
  const write = file => rules.check('Write', { file_path: file })?.deny ?? null
  assert.ok(write('/proj/src/a.ts'))
  assert.equal(write('/proj/vendor/src/a.ts'), null) // /src is anchored at the project
  assert.ok(write('/proj/.env')) // a Read deny also stops writes
  assert.ok(rules.check('Grep', { path: '/proj/a/secrets' }))
  assert.equal(rules.hidden('/proj/a/secrets/x'), true)
  assert.equal(rules.hidden('/proj/README.md'), false)
})

test('MCP rules by server and by glob', () => {
  const rules = rulesFor({ deny: ['mcp__browser', 'mcp__db__drop_*', 'mcp__x__y(arg:1)'] })
  assert.ok(rules.check('mcp__browser__navigate', {}))
  assert.ok(rules.check('mcp__db__drop_table', {}))
  assert.equal(rules.check('mcp__db__query', {}), null)
  assert.equal(rules.check('mcp__x__y', {}), null) // MCP rules with parentheses are skipped, as in Claude Code
  assert.ok(rulesFor({ deny: ['mcp__*'] }).check('mcp__any__tool', {}))
})

test('helpers follow the project settings: refused reads, hidden search results, function edits checked as reads', async () => {
  const dir = project({ '.env': 'TOKEN=1\n', 'app.ts': 'const TOKEN = process.env.TOKEN\n', 'locked.txt': 'x\n' })
  mkdirSync(path.join(dir, '.claude'), { recursive: true })
  writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(./.env)', 'Edit(locked.txt)'] } }))
  const run = fakeRun()
  const env = { projectDir: dir, guard: createGuard({ projectDir: dir, hooks: 'on' }), history: [], run: () => run }
  const files = createFiles(env)
  const search = createSearch(env)
  await assert.rejects(files.read('.env'), /Read\(\.\/\.env\)/)
  await assert.rejects(files.edit('.env', text => text), /Read\(\.\/\.env\)/)
  await assert.rejects(files.edit('locked.txt', 'x', 'y'), /Edit\(locked\.txt\)/)
  await assert.rejects(files.edit('locked.txt', text => `${text}y`), /Edit\(locked\.txt\)/)
  await assert.rejects(files.exists('.env'), /Read\(\.\/\.env\)/)
  const hits = await search.grep('TOKEN', { hidden: true })
  assert.deepEqual(hits.map(hit => hit.file), ['app.ts'])
  assert.ok(run.notes.some(note => /left out 1 file/.test(note)))
  assert.deepEqual(await search.glob('*', { hidden: true }), ['app.ts', 'locked.txt'])
  assert.ok(!(await files.ls('.')).includes('.env'))
})

test('rules see through letter case, links to folders, process substitution; ask Read rules cover edits', async () => {
  const { mkdtempSync, symlinkSync, realpathSync } = await import('node:fs')
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lever-rules-')))
  mkdirSync(path.join(base, 'secrets'))
  symlinkSync(path.join(base, 'secrets'), path.join(base, 'link'))
  const rules = rulesFor({ deny: ['Read(secrets/**)', 'Bash(rm *)'], ask: ['Read(notes.md)'] }, { root: base, cwd: base })
  assert.ok(rules.check('Write', { file_path: path.join(base, 'link', 'new.txt') }), 'a new file under a link into secrets')
  if (process.platform === 'darwin') assert.ok(rules.check('Read', { file_path: path.join(base, 'SECRETS', 'a.txt') }), 'letter case')
  assert.ok(rules.check('Bash', { command: 'diff <(rm -rf x) y' }))
  assert.ok(rules.check('Bash', { command: 'echo "$(echo ")" && rm -rf x)"' }))
  assert.match(rules.check('Edit', { file_path: path.join(base, 'notes.md') })?.deny ?? '', /wants a person/)
})

test('escaped parentheses and dangling links do not slip past', async () => {
  const { mkdtempSync, symlinkSync, realpathSync } = await import('node:fs')
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lever-rules-')))
  mkdirSync(path.join(base, 'secrets'))
  symlinkSync(path.join(base, 'secrets', 'planted.txt'), path.join(base, 'dangling'))
  const rules = rulesFor({ deny: ['Read(secrets/**)', 'Bash(rm *)'] }, { root: base, cwd: base })
  assert.ok(rules.check('Bash', { command: 'echo $(echo \\) && rm -rf x)' }))
  assert.ok(rules.check('Write', { file_path: path.join(base, 'dangling') }))
})

test('paths resolve link by link from the real folder, and endless links are refused', async () => {
  const { mkdtempSync, symlinkSync, realpathSync } = await import('node:fs')
  const { resolvePath } = await import('../src/rules.mjs')
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lever-rules-')))
  mkdirSync(path.join(base, 'secrets'))
  mkdirSync(path.join(base, 'a', 'b'), { recursive: true })
  symlinkSync(path.join(base, 'a', 'b'), path.join(base, 'hop'))
  symlinkSync('../../secrets/new.txt', path.join(base, 'a', 'b', 'rel')) // relative to the real folder a/b
  symlinkSync(path.join(base, 'loop2'), path.join(base, 'loop1'))
  symlinkSync(path.join(base, 'loop1'), path.join(base, 'loop2'))
  assert.equal(resolvePath(path.join(base, 'hop', 'rel')), path.join(base, 'secrets', 'new.txt'))
  assert.equal(resolvePath(path.join(base, 'loop1', 'x')), null)
  const rules = rulesFor({ deny: ['Edit(secrets/**)'] }, { root: base, cwd: base })
  assert.ok(rules.check('Write', { file_path: path.join(base, 'hop', 'rel') }))
  assert.ok(rules.check('Write', { file_path: path.join(base, 'loop1', 'x') }))
  assert.equal(rules.check('Write', { file_path: path.join(base, 'a', 'ok.txt') }), null)
})
