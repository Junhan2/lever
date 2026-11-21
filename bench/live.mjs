// The same requests sent to real Claude Code: once with only the built-in tools, once with only lever's run. Tokens,
// cost, time and turns come from Claude Code's own JSON result, and each answer is checked. It calls the model, so it
// is not part of npm test: node bench/live.mjs [model] [repeats] (default haiku, 3). Every request works on its own copy
// of this repository, and each row shows the median of the repeats.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MODEL = process.argv[2] ?? 'haiku'
const REPEATS = Number(process.argv[3] ?? 3)
const BUILT_IN = ['Glob', 'Grep', 'Read', 'Edit', 'Write', 'Bash']

function copyRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lever-live-'))
  for (const part of ['src', 'test', 'bin', 'package.json']) cpSync(path.join(ROOT, part), path.join(dir, part), { recursive: true })
  return dir
}
const listFiles = (dir, base = dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))])).sort()
const filesMentioning = (dir, word) => listFiles(dir).filter(file => new RegExp(`\\b${word}\\b`).test(readFileSync(path.join(dir, file), 'utf8')))

const TASKS = [
  {
    name: 'Three longest source files',
    prompt: "Find the three .mjs files under src/ (including subfolders) with the most lines. Reply with only 'path: lines' for each, longest first.",
    check(dir, answer) {
      const sizes = listFiles(path.join(dir, 'src')).filter(f => f.endsWith('.mjs')).map(f => [`src/${f}`, readFileSync(path.join(dir, 'src', f), 'utf8').split('\n').length])
      const positions = sizes.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => answer.indexOf(f))
      return positions.every(p => p >= 0) && positions[0] < positions[1] && positions[1] < positions[2]
    },
  },
  {
    name: 'Where each export of format.mjs is used',
    prompt: "For each function or constant that src/format.mjs exports, count how many other files in this project contain its name as a whole word. Reply with only one line per export: 'name: count'.",
    check(dir, answer) {
      const source = readFileSync(path.join(dir, 'src/format.mjs'), 'utf8')
      const names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m => m[1])
      return names.every(name => {
        const count = filesMentioning(dir, name).filter(file => file !== path.join('src', 'format.mjs')).length
        return new RegExp(`\\b${name}\\b\\D{0,12}?\\b${count}\\b`).test(answer)
      })
    },
  },
  {
    name: 'Rename a function everywhere',
    prompt: 'Rename the function cutMiddle to cutInMiddle everywhere in this project, its definition and every use. Reply with only the list of files you changed.',
    check(dir) {
      const expected = copyRepo()
      for (const file of listFiles(expected)) {
        const full = path.join(expected, file)
        writeFileSync(full, readFileSync(full, 'utf8').split('cutMiddle').join('cutInMiddle'))
      }
      return listFiles(expected).every(file => existsSync(path.join(dir, file)) && readFileSync(path.join(dir, file), 'utf8') === readFileSync(path.join(expected, file), 'utf8'))
    },
  },
  {
    name: 'Run the tests, report only failures',
    prepare(dir) {
      // one failing check, so there is something to report
      const file = path.join(dir, 'test/format.test.mjs')
      writeFileSync(file, readFileSync(file, 'utf8').replace("assert.equal(render(42), '42')", "assert.equal(render(42), '43')"))
    },
    prompt: 'Run npm test. Reply with only the names of the tests that fail and the file each is in.',
    check: (dir, answer) => answer.includes('renders values the way a person would want to read them') && answer.includes('format.test.mjs'),
  },
]

function ask(dir, prompt, withLever) {
  // The config lives outside the copy, so the copy holds only the project files the checks compare.
  const config = path.join(mkdtempSync(path.join(os.tmpdir(), 'lever-live-config-')), 'mcp.json')
  const server = { command: process.execPath, args: [path.join(ROOT, 'bin', 'lever.mjs')], env: { CLAUDE_PROJECT_DIR: dir } }
  writeFileSync(config, JSON.stringify({ mcpServers: { lever: server } }))
  // The prompt comes first: --allowedTools and --disallowedTools take several values and would swallow it.
  const args = ['-p', prompt, '--model', MODEL, '--output-format', 'json', '--strict-mcp-config']
  if (withLever) args.push('--mcp-config', config, '--allowedTools', 'mcp__lever__run', '--disallowedTools', ...BUILT_IN)
  else args.push('--allowedTools', ...BUILT_IN)
  const started = Date.now()
  const out = spawnSync('claude', args, { cwd: dir, encoding: 'utf8', input: '', timeout: 600_000 })
  try {
    return { ...JSON.parse(out.stdout), wall: Date.now() - started }
  } catch {
    return { error: (out.stderr || out.stdout).slice(0, 400), wall: Date.now() - started }
  }
}

const median = values => {
  const sorted = values.filter(v => typeof v === 'number').sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const rows = []
for (const task of TASKS) {
  for (const withLever of [false, true]) {
    const runs = []
    for (let i = 0; i < REPEATS; i++) {
      const dir = copyRepo()
      task.prepare?.(dir)
      const result = ask(dir, task.prompt, withLever)
      const usage = result.usage ?? {}
      runs.push({
        turns: result.num_turns,
        input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        output: usage.output_tokens ?? 0,
        cost: result.total_cost_usd,
        seconds: (result.duration_ms ?? result.wall) / 1000,
        correct: !result.error && result.is_error !== true && task.check(dir, String(result.result ?? '')),
        error: result.error,
      })
      console.error(`${task.name} · ${withLever ? 'lever' : 'built-in'} · run ${i + 1}: ${runs.at(-1).correct ? 'correct' : `wrong${result.error ? ` (${result.error})` : `: ${String(result.result ?? '').slice(0, 200)}`}`}`)
    }
    const pick = key => median(runs.map(run => run[key]))
    rows.push({ task: task.name, way: withLever ? 'lever run' : 'built-in tools', turns: pick('turns'), input: pick('input'), output: pick('output'), cost: pick('cost'), seconds: pick('seconds'), correct: `${runs.filter(r => r.correct).length}/${runs.length}` })
  }
}

const n = value => (value === undefined ? '?' : Math.round(value).toLocaleString('en-US'))
console.log(`Claude Code ${spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim()}, model ${MODEL}, median of ${REPEATS} runs per row. Input tokens include cached ones.\n`)
console.log('| Task | Way | Turns | Input tokens | Output tokens | Cost (USD) | Time (s) | Correct |')
console.log('| :- | :- | -: | -: | -: | -: | -: | :-: |')
for (const r of rows) console.log(`| ${r.task} | ${r.way} | ${r.turns ?? '?'} | ${n(r.input)} | ${n(r.output)} | ${r.cost?.toFixed(4) ?? '?'} | ${r.seconds?.toFixed(1) ?? '?'} | ${r.correct} |`)
const total = (way, key) => rows.filter(r => r.way === way).reduce((sum, r) => sum + (r[key] ?? 0), 0)
const change = key => {
  const before = total('built-in tools', key)
  const after = total('lever run', key)
  return `${key} ${n(before)} → ${n(after)} (${before ? `${((after / before - 1) * 100).toFixed(0)}%` : '?'})`
}
console.log(`\nSum over the tasks, built-in → lever: ${['input', 'output', 'turns'].map(change).join(' · ')} · cost ${total('built-in tools', 'cost').toFixed(4)} → ${total('lever run', 'cost').toFixed(4)} · time ${total('built-in tools', 'seconds').toFixed(1)} s → ${total('lever run', 'seconds').toFixed(1)} s`)
