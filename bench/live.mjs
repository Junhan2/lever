// The same requests sent to real Claude Code three ways: with only the built-in tools, with the built-in tools and
// lever (the way people install it), and with only lever's run. Tokens, cost and time come from Claude Code's own
// result, the model calls and tool calls from its event stream, and each answer is checked. A model call is one round
// trip to the model. Claude Code's num_turns is the number of tool calls plus one, so it is not used. This script calls
// the model, so it is not part of npm test: node bench/live.mjs [model] [repeats] (default haiku, 3). Every request
// works on its own copy of this repository, and each row shows the median of the repeats.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MODEL = process.argv[2] ?? 'haiku'
const REPEATS = Number(process.argv[3] ?? 3)
const BUILT_IN = ['Glob', 'Grep', 'Read', 'Edit', 'Write', 'Bash']
const LEVER = 'mcp__lever__run'
const WAYS = [
  { name: 'built-in tools', lever: false, flags: () => ['--allowedTools', ...BUILT_IN] },
  { name: 'built-in tools + lever', lever: true, flags: () => ['--allowedTools', ...BUILT_IN, LEVER] },
  { name: 'lever only', lever: true, flags: () => ['--allowedTools', LEVER, '--disallowedTools', ...BUILT_IN] },
]

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

function ask(dir, prompt, way) {
  // The prompt comes first: --allowedTools and --disallowedTools take several values and would swallow it.
  // Sessions are not saved: each run would otherwise leave a project folder in the user's Claude Code history.
  const args = ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--no-session-persistence']
  if (way.lever) {
    // The config lives outside the copy, so the copy holds only the project files the checks compare.
    const config = path.join(mkdtempSync(path.join(os.tmpdir(), 'lever-live-config-')), 'mcp.json')
    const server = { command: process.execPath, args: [path.join(ROOT, 'bin', 'lever.mjs')], env: { CLAUDE_PROJECT_DIR: dir } }
    writeFileSync(config, JSON.stringify({ mcpServers: { lever: server } }))
    args.push('--mcp-config', config)
  }
  args.push(...way.flags())
  const started = Date.now()
  const out = spawnSync('claude', args, { cwd: dir, encoding: 'utf8', input: '', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 })
  const events = out.stdout.split('\n').flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
  const calls = events.filter(e => e.type === 'assistant').flatMap(e => (e.message?.content ?? []).filter(c => c.type === 'tool_use').map(c => c.name))
  const rounds = new Set(events.filter(e => e.type === 'assistant' && e.message?.id).map(e => e.message.id)).size
  const result = events.findLast(e => e.type === 'result')
  if (!result) return { error: (out.stderr || out.stdout).slice(0, 400), calls, rounds, wall: Date.now() - started }
  return { ...result, calls, rounds, wall: Date.now() - started }
}

const median = values => {
  const sorted = values.filter(v => typeof v === 'number').sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const rows = []
for (const task of TASKS) {
  for (const way of WAYS) {
    const runs = []
    for (let i = 0; i < REPEATS; i++) {
      const dir = copyRepo()
      task.prepare?.(dir)
      const result = ask(dir, task.prompt, way)
      const usage = result.usage ?? {}
      const answer = String(result.result ?? '')
      runs.push({
        rounds: result.rounds,
        calls: result.calls.length,
        usedLever: result.calls.includes(LEVER),
        input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        output: usage.output_tokens ?? 0,
        cost: result.total_cost_usd,
        seconds: (result.duration_ms ?? result.wall) / 1000,
        correct: !result.error && result.is_error !== true && task.check(dir, answer),
      })
      const run = runs.at(-1)
      console.error(`${task.name} · ${way.name} · run ${i + 1}: ${run.correct ? 'correct' : `wrong${result.error ? ` (${result.error})` : `: ${answer.slice(0, 200)}`}`} · calls: ${result.calls.join(', ') || 'none'}`)
    }
    const pick = key => median(runs.map(run => run[key]))
    rows.push({
      task: task.name,
      way: way.name,
      rounds: pick('rounds'),
      calls: pick('calls'),
      usedLever: way.lever ? `${runs.filter(r => r.usedLever).length}/${runs.length}` : '-',
      input: pick('input'),
      output: pick('output'),
      cost: pick('cost'),
      seconds: pick('seconds'),
      correct: `${runs.filter(r => r.correct).length}/${runs.length}`,
    })
  }
}

const n = value => (value === undefined ? '?' : Math.round(value).toLocaleString('en-US'))
console.log(`Claude Code ${spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim()}, model ${MODEL}, median of ${REPEATS} runs per row. Input tokens include cached ones.\n`)
console.log('| Task | Way | Model calls | Tool calls | Used lever | Input tokens | Output tokens | Cost (USD) | Time (s) | Correct |')
console.log('| :- | :- | -: | -: | :-: | -: | -: | -: | -: | :-: |')
for (const r of rows) {
  console.log(`| ${r.task} | ${r.way} | ${r.rounds ?? '?'} | ${r.calls ?? '?'} | ${r.usedLever} | ${n(r.input)} | ${n(r.output)} | ${r.cost?.toFixed(4) ?? '?'} | ${r.seconds?.toFixed(1) ?? '?'} | ${r.correct} |`)
}
const total = (way, key) => rows.filter(r => r.way === way).reduce((sum, r) => sum + (r[key] ?? 0), 0)
const base = WAYS[0].name
const LABELS = { input: 'input', output: 'output', rounds: 'model calls', calls: 'tool calls' }
for (const way of WAYS.slice(1)) {
  const change = key => {
    const before = total(base, key)
    const after = total(way.name, key)
    return `${LABELS[key]} ${n(before)} → ${n(after)} (${before ? `${after >= before ? '+' : ''}${((after / before - 1) * 100).toFixed(0)}%` : '?'})`
  }
  console.log(`\nSum over the tasks, ${base} → ${way.name}: ${['input', 'output', 'rounds', 'calls'].map(change).join(' · ')} · cost ${total(base, 'cost').toFixed(4)} → ${total(way.name, 'cost').toFixed(4)} · time ${total(base, 'seconds').toFixed(1)} s → ${total(way.name, 'seconds').toFixed(1)} s`)
}
