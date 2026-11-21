// What the model reads back, measured without a model: four everyday tasks done once with one tool call per step (the
// way Claude Code's built-in tools return results) and once with a single lever run. Both work on copies of this
// repository, so anyone can rerun it: npm run bench. Tokens are estimated as characters / 4.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN = path.join(ROOT, 'bin', 'lever.mjs')
const PREFIX = '/Users/me/code/lever/' // a typical project path, for the absolute paths built-in tools print

function copyRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lever-bench-'))
  for (const part of ['src', 'test', 'bin', 'package.json']) cpSync(path.join(ROOT, part), path.join(dir, part), { recursive: true })
  return dir
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)]
    })
    .sort()
}

/** Read's output: the file with line numbers, as `cat -n` prints it. */
const catN = text => text.replace(/\n$/, '').split('\n').map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n')

function rgFiles(dir, pattern) {
  const out = spawnSync('rg', ['--files-with-matches', '-e', pattern, '.'], { cwd: dir, encoding: 'utf8' }).stdout
  return out.split('\n').filter(Boolean).map(file => file.replace(/^\.\//, '')).sort()
}

function timed(fn) {
  const started = performance.now()
  const value = fn()
  return { value, ms: performance.now() - started }
}

const TASKS = [
  {
    name: 'Three longest source files',
    baseline(dir) {
      const files = listFiles(path.join(dir, 'src')).filter(f => f.endsWith('.mjs')).map(f => `src/${f}`)
      const calls = [{ tool: 'Glob', input: { pattern: 'src/**/*.mjs' }, output: files.map(f => PREFIX + f).join('\n') }]
      for (const file of files) calls.push({ tool: 'Read', input: { file_path: PREFIX + file }, output: catN(readFileSync(path.join(dir, file), 'utf8')) })
      return calls
    },
    code: `const files = await glob('src/**/*.mjs')
const sizes = await Promise.all(files.map(async f => ({ f, n: (await read(f)).split('\\n').length })))
sizes.sort((a, b) => b.n - a.n).slice(0, 3).map(s => \`\${s.f}: \${s.n}\`).join('\\n')`,
  },
  {
    name: 'Where each export of format.mjs is used',
    baseline(dir) {
      const source = readFileSync(path.join(dir, 'src/format.mjs'), 'utf8')
      const names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m => m[1])
      const calls = [{ tool: 'Read', input: { file_path: `${PREFIX}src/format.mjs` }, output: catN(source) }]
      for (const name of names) {
        const files = rgFiles(dir, `\\b${name}\\b`)
        calls.push({ tool: 'Grep', input: { pattern: `\\b${name}\\b`, output_mode: 'files_with_matches' }, output: `Found ${files.length} files\n${files.map(f => PREFIX + f).join('\n')}` })
      }
      return calls
    },
    code: `const src = await read('src/format.mjs')
const names = [...src.matchAll(/export (?:async )?(?:function|const) (\\w+)/g)].map(m => m[1])
const out = {}
for (const name of names) out[name] = (await grep(\`\\\\b\${name}\\\\b\`, { files: true })).filter(f => f !== 'src/format.mjs').length
out`,
  },
  {
    name: 'Rename a function everywhere',
    baseline(dir) {
      const files = rgFiles(dir, 'cutMiddle')
      const calls = [{ tool: 'Grep', input: { pattern: 'cutMiddle', output_mode: 'files_with_matches' }, output: `Found ${files.length} files\n${files.map(f => PREFIX + f).join('\n')}` }]
      for (const file of files) {
        const full = path.join(dir, file)
        const text = readFileSync(full, 'utf8')
        calls.push({ tool: 'Read', input: { file_path: PREFIX + file }, output: catN(text) }) // Edit needs a Read first
        writeFileSync(full, text.split('cutMiddle').join('cutInMiddle'))
        calls.push({
          tool: 'Edit',
          input: { file_path: PREFIX + file, old_string: 'cutMiddle', new_string: 'cutInMiddle', replace_all: true },
          output: `The file ${PREFIX + file} has been updated successfully.`,
        })
      }
      return calls
    },
    code: `const files = await grep('cutMiddle', { files: true })
for (const f of files) await edit(f, 'cutMiddle', 'cutInMiddle', { all: true })
files`,
    sameResult: true,
  },
  {
    name: 'Run the tests, report only failures',
    prepare(dir) {
      // one failing check, so there is something to report
      const file = path.join(dir, 'test/format.test.mjs')
      writeFileSync(file, readFileSync(file, 'utf8').replace("assert.equal(render(42), '42')", "assert.equal(render(42), '43')"))
    },
    baseline(dir) {
      const result = spawnSync('npm', ['test'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } })
      return [{ tool: 'Bash', input: { command: 'npm test' }, output: `${result.stdout}${result.stderr}`.trim() }]
    },
    code: `const r = await $\`npm test\`.nothrow()
const lines = (r.stdout + r.stderr).split('\\n')
const failed = [...new Set(lines.filter(l => /^✖ /.test(l)).map(l => l.replace(/ \\([\\d.]+ms\\)$/, '')))]
const where = lines.filter(l => /AssertionError|at TestContext.* \\(file:/.test(l)).slice(0, 4).map(l => l.trim())
return { exit: r.exitCode, totals: lines.filter(l => /^ℹ (tests|pass|fail) /.test(l)).join(', '), failed, where }`,
  },
]

function connect(dir) {
  const child = spawn(process.execPath, [BIN], {
    cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDECODE: '', LEVER_HOOKS: 'off' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const waiting = new Map()
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line)
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
  })
  let seq = 0
  const request = (method, params) =>
    new Promise(resolve => {
      const id = ++seq
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  return { request, close: () => new Promise(resolve => child.on('exit', resolve) && child.stdin.end()) }
}

const tokens = chars => Math.round(chars / 4)
const sameTree = (a, b) => {
  const files = listFiles(a)
  return files.length === listFiles(b).length && files.every(file => readFileSync(path.join(a, file), 'utf8') === readFileSync(path.join(b, file), 'utf8'))
}

const rows = []
for (const task of TASKS) {
  const baseDir = copyRepo()
  const leverDir = copyRepo()
  task.prepare?.(baseDir)
  task.prepare?.(leverDir)
  const base = timed(() => task.baseline(baseDir))
  const baseIn = base.value.reduce((sum, call) => sum + JSON.stringify(call.input).length, 0)
  const baseOut = base.value.reduce((sum, call) => sum + call.output.length, 0)

  const client = connect(leverDir)
  await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: 'bench' } })
  const started = performance.now()
  const reply = await client.request('tools/call', { name: 'run', arguments: { code: task.code } })
  const leverMs = performance.now() - started
  await client.close()
  const text = reply.result.content[0].text
  const leverIn = JSON.stringify({ code: task.code }).length
  rows.push({
    task: task.name,
    calls: [base.value.length, 1],
    written: [baseIn, leverIn],
    read: [baseOut, text.length],
    ms: [base.ms, leverMs],
    same: task.sameResult ? sameTree(baseDir, leverDir) : null,
    reply: text,
  })
}

const pct = (before, after) => `${((1 - after / before) * 100).toFixed(1)}%`
const lines = [
  '| Task | Tool calls (one per step → lever) | Model writes, chars | Model reads, chars | ≈ tokens read (chars ÷ 4) | Fewer tokens read |',
  '| :- | :-: | -: | -: | -: | -: |',
]
for (const row of rows) {
  lines.push(
    `| ${row.task} | ${row.calls[0]} → ${row.calls[1]} | ${row.written[0].toLocaleString('en-US')} → ${row.written[1].toLocaleString('en-US')} | ${row.read[0].toLocaleString('en-US')} → ${row.read[1].toLocaleString('en-US')} | ${tokens(row.read[0]).toLocaleString('en-US')} → ${tokens(row.read[1]).toLocaleString('en-US')} | ${pct(row.read[0], row.read[1])} |`,
  )
}
const total = key => rows.reduce((sum, row) => [sum[0] + row[key][0], sum[1] + row[key][1]], [0, 0])
const [readBefore, readAfter] = total('read')
const [callsBefore, callsAfter] = total('calls')
lines.push(`| **All four** | ${callsBefore} → ${callsAfter} | | ${readBefore.toLocaleString('en-US')} → ${readAfter.toLocaleString('en-US')} | ${tokens(readBefore).toLocaleString('en-US')} → ${tokens(readAfter).toLocaleString('en-US')} | ${pct(readBefore, readAfter)} |`)
console.log(lines.join('\n'))
console.log('\nlever run time per task (ms, server already started): ' + rows.map(row => `${row.task}: ${Math.round(row.ms[1])}`).join(' · '))
for (const row of rows.filter(r => r.same !== null)) console.log(`${row.task}: both ways leave the same files: ${row.same}`)
if (process.argv.includes('--replies')) for (const row of rows) console.log(`\n## ${row.task}\n${row.reply}`)
