// Runs the stress tasks in real Claude Code three ways (built-in tools only, built-in tools and lever, lever only) and
// records every run: whether the answer was right, model calls, tool calls, tokens, cost, time, the errors the tools
// returned and the code sent to lever. It calls the model, so it uses your Claude Code account.
// "Model calls" are round trips to the model, counted from the event stream. Claude Code's own num_turns is the number
// of tool calls plus one, which hides that the built-in tools can run several calls in one round trip.
//   node bench/stress/run.mjs [--model haiku] [--repeats 3] [--ways built-in,both,lever] [--tasks fix-tests,dependents]
//                             [--concurrency 3] [--out runs.jsonl] [--lever /path/to/bin/lever.mjs] [--user-settings]
//                             [--lever-env LEVER_MAX_OUTPUT=8000]   a setting for the lever server (repeatable)
//   node bench/stress/run.mjs --report runs.jsonl       prints the tables for saved runs without running anything
// Each run works on a fresh copy of the generated project. By default your user settings (CLAUDE.md, plugins, hooks)
// stay out, so the numbers are close to what a fresh install sees; --user-settings keeps them in.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeProject } from './project.mjs'
import { TASKS } from './tasks.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BUILT_IN = ['Glob', 'Grep', 'Read', 'Edit', 'Write', 'Bash']
const LEVER = 'mcp__lever__run'
const WAYS = {
  'built-in': { label: 'built-in tools', lever: false, flags: ['--allowedTools', ...BUILT_IN] },
  both: { label: 'built-in tools + lever', lever: true, flags: ['--allowedTools', ...BUILT_IN, LEVER] },
  lever: { label: 'lever only', lever: true, flags: ['--allowedTools', LEVER, '--disallowedTools', ...BUILT_IN] },
}
// What "a real gain on complex work" has to mean, fixed before measuring. Changes are against built-in tools only.
export const PASS_LINES = [
  { key: 'correct', label: 'Right answers', target: 'not fewer than with built-in tools', pass: (base, way) => way.correct >= base.correct },
  { key: 'rounds', label: 'Model calls', target: 'at least 30% fewer', pass: (base, way) => way.rounds <= base.rounds * 0.7 },
  { key: 'input', label: 'Input tokens', target: 'at least 25% fewer', pass: (base, way) => way.input <= base.input * 0.75 },
  { key: 'output', label: 'Output tokens', target: 'not more than 10% above', pass: (base, way) => way.output <= base.output * 1.1 },
  { key: 'cost', label: 'Cost', target: 'at least 15% lower', pass: (base, way) => way.cost <= base.cost * 0.85 },
  { key: 'seconds', label: 'Time', target: 'not slower', pass: (base, way) => way.seconds <= base.seconds },
]

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

function runOne({ task, way, repeat, model, leverBin, leverEnv, userSettings }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lever-stress-'))
  makeProject(dir, task.fixture)
  // The prompt comes first: --allowedTools and --disallowedTools take several values and would swallow it.
  // Sessions are not saved: each run would otherwise leave a project folder in the user's Claude Code history.
  const flags = ['-p', task.prompt, '--model', model, '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--no-session-persistence', '--max-turns', '40']
  if (!userSettings) flags.push('--setting-sources', 'project,local')
  let configDir = null
  if (WAYS[way].lever) {
    // lever runs without the owner's own hooks, guards and config, like the rest of this clean setup
    configDir = mkdtempSync(path.join(os.tmpdir(), 'lever-stress-config-'))
    const server = { command: process.execPath, args: [leverBin], env: { CLAUDE_PROJECT_DIR: dir, LEVER_HOOKS: 'off', LEVER_CONFIG: path.join(configDir, 'none.json'), ...leverEnv } }
    writeFileSync(path.join(configDir, 'mcp.json'), JSON.stringify({ mcpServers: { lever: server } }))
    flags.push('--mcp-config', path.join(configDir, 'mcp.json'))
  }
  flags.push(...WAYS[way].flags)
  const started = Date.now()
  return new Promise(resolve => {
    const child = spawn('claude', flags, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (err = (err + chunk).slice(-2000)))
    const timer = setTimeout(() => child.kill('SIGKILL'), 900_000)
    child.on('close', () => {
      clearTimeout(timer)
      const names = new Map()
      const tools = []
      const errors = []
      const rounds = new Set()
      const leverCalls = new Map()
      let result = null
      for (const line of out.split('\n')) {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'assistant' && event.message?.id) rounds.add(event.message.id)
        const content = Array.isArray(event.message?.content) ? event.message.content : []
        for (const block of content) {
          if (block.type === 'tool_use') {
            names.set(block.id, block.name)
            tools.push(block.name)
            if (block.name === LEVER) leverCalls.set(block.id, { code: String(block.input?.code ?? '').slice(0, 1500) })
          } else if (block.type === 'tool_result') {
            const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map(part => part.text ?? '').join(' ')
            if (block.is_error) errors.push({ tool: names.get(block.tool_use_id) ?? '?', text: text.slice(0, 400) })
            const call = leverCalls.get(block.tool_use_id)
            if (call) Object.assign(call, { error: Boolean(block.is_error), reply: text.slice(0, 500), replyChars: text.length })
          }
        }
        if (event.type === 'result') result = event
      }
      const usage = result?.usage ?? {}
      const answer = String(result?.result ?? '')
      let verdict
      try {
        verdict = result ? task.check(dir, answer) : `no result (${err.trim().split('\n').at(-1) ?? 'no output'})`
      } catch (error) {
        verdict = `checker failed: ${error.message}`
      }
      rmSync(dir, { recursive: true, force: true })
      if (configDir) rmSync(configDir, { recursive: true, force: true })
      resolve({
        task: task.key,
        way,
        model,
        repeat,
        settings: Object.entries(leverEnv).map(pair => pair.join('=')).join(' '),
        correct: verdict === true,
        why: verdict === true ? null : String(verdict).slice(0, 300),
        rounds: rounds.size,
        calls: tools.length,
        tools,
        usedLever: tools.includes(LEVER),
        input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        output: usage.output_tokens ?? 0,
        cost: result?.total_cost_usd ?? null,
        seconds: (result?.duration_ms ?? Date.now() - started) / 1000,
        stop: result?.subtype ?? 'none',
        errors,
        lever: [...leverCalls.values()],
        answer: answer.slice(0, 300),
      })
    })
  })
}

const median = values => {
  const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b)
  if (!sorted.length) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const n = value => Math.round(value).toLocaleString('en-US')
const change = (before, after) => (before ? `${after >= before ? '+' : '−'}${Math.abs((after / before - 1) * 100).toFixed(0)}%` : '?')

export function report(rows) {
  const lines = []
  const models = [...new Set(rows.map(row => row.model))]
  for (const model of models) {
    const mine = rows.filter(row => row.model === model)
    const ways = Object.keys(WAYS).filter(way => mine.some(row => row.way === way))
    const tasks = TASKS.filter(task => mine.some(row => row.task === task.key))
    const cell = (task, way) => {
      const runs = mine.filter(row => row.task === task && row.way === way)
      const pick = key => median(runs.map(run => run[key]))
      return { runs: runs.length, correct: runs.filter(run => run.correct).length, usedLever: runs.filter(run => run.usedLever).length, rounds: pick('rounds'), calls: pick('calls'), input: pick('input'), output: pick('output'), cost: pick('cost'), seconds: pick('seconds') }
    }
    const repeats = Math.max(...mine.map(row => row.repeat))
    lines.push(`## ${model}: ${tasks.length} tasks, median of ${repeats} run${repeats === 1 ? '' : 's'} per row`, '')
    lines.push('| Task | Way | Right | Used lever | Model calls | Tool calls | Input tokens | Output tokens | Cost (USD) | Time (s) |', '| :- | :- | :-: | :-: | -: | -: | -: | -: | -: | -: |')
    const totals = Object.fromEntries(ways.map(way => [way, { runs: 0, correct: 0, usedLever: 0, rounds: 0, calls: 0, input: 0, output: 0, cost: 0, seconds: 0 }]))
    for (const task of tasks) {
      for (const way of ways) {
        const c = cell(task.key, way)
        for (const key of Object.keys(totals[way])) totals[way][key] += c[key]
        lines.push(`| ${task.name} | ${WAYS[way].label} | ${c.correct}/${c.runs} | ${WAYS[way].lever ? `${c.usedLever}/${c.runs}` : '-'} | ${c.rounds} | ${c.calls} | ${n(c.input)} | ${n(c.output)} | ${c.cost.toFixed(4)} | ${c.seconds.toFixed(1)} |`)
      }
    }
    lines.push('', '| Sum over the tasks | Right | Model calls | Tool calls | Input tokens | Output tokens | Cost (USD) | Time (s) |', '| :- | :-: | -: | -: | -: | -: | -: | -: |')
    const base = totals['built-in']
    for (const way of ways) {
      const t = totals[way]
      const versus = key => (way === 'built-in' || !base ? '' : ` (${change(base[key], t[key])})`)
      lines.push(`| ${WAYS[way].label} | ${t.correct}/${t.runs} | ${t.rounds}${versus('rounds')} | ${t.calls}${versus('calls')} | ${n(t.input)}${versus('input')} | ${n(t.output)}${versus('output')} | ${t.cost.toFixed(4)}${versus('cost')} | ${t.seconds.toFixed(1)}${versus('seconds')} |`)
    }
    if (base) {
      const others = ways.filter(way => way !== 'built-in')
      lines.push('', `| Pass line | Target | ${others.map(way => WAYS[way].label).join(' | ')} |`, `| :- | :- | ${others.map(() => ':-').join(' | ')} |`)
      for (const line of PASS_LINES) {
        const show = way => {
          const t = totals[way]
          const value = line.key === 'correct' ? `${t.correct}/${t.runs} against ${base.correct}/${base.runs}` : change(base[line.key], t[line.key])
          return `${line.pass(base, t) ? 'pass' : 'FAIL'} (${value})`
        }
        lines.push(`| ${line.label} | ${line.target} | ${others.map(show).join(' | ')} |`)
      }
      if (totals.both) lines.push(`| lever chosen in a normal install | in at least 80% of runs | ${totals.both.usedLever / totals.both.runs >= 0.8 ? 'pass' : 'FAIL'} (${totals.both.usedLever}/${totals.both.runs}) | - |`)
    }
    const wrong = mine.filter(row => !row.correct)
    if (wrong.length) lines.push('', 'Wrong or unfinished runs:', ...wrong.map(row => `- ${row.task} · ${WAYS[row.way].label} · run ${row.repeat}: ${row.why} (${row.rounds} model calls, stop: ${row.stop})`))
    const failures = new Map()
    for (const row of mine) {
      for (const error of row.errors) {
        const key = `${error.tool === LEVER ? 'lever' : error.tool}: ${error.text.split('\n')[0].replace(/\/[^\s'"]+\/(lever-stress-\w+)/g, '<project>').replace(/\d+/g, 'N').slice(0, 110)}`
        failures.set(key, (failures.get(key) ?? 0) + 1)
      }
    }
    if (failures.size) lines.push('', 'Errors the tools returned (count · first line):', ...[...failures].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([text, count]) => `- ${count} · ${text}`))
    lines.push('')
  }
  return lines.join('\n')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const saved = option('report')
  if (saved) {
    const files = args.slice(args.indexOf('--report') + 1).filter(arg => !arg.startsWith('--'))
    console.log(report(files.flatMap(file => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))))
  } else {
    const model = option('model', 'haiku')
    const repeats = Number(option('repeats', 3))
    const ways = option('ways', 'built-in,both,lever').split(',')
    const wanted = option('tasks')?.split(',')
    const tasks = TASKS.filter(task => !wanted || wanted.includes(task.key))
    const out = option('out', path.join(os.tmpdir(), `lever-stress-${Date.now()}.jsonl`))
    const leverBin = path.resolve(option('lever', path.join(ROOT, 'bin', 'lever.mjs')))
    const leverEnv = Object.fromEntries(args.flatMap((arg, index) => (args[index - 1] === '--lever-env' ? [[arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]] : [])))
    const jobs = []
    for (let repeat = 1; repeat <= repeats; repeat++) for (const task of tasks) for (const way of ways) jobs.push({ task, way, repeat, model, leverBin, leverEnv, userSettings: args.includes('--user-settings') })
    console.error(`${jobs.length} runs · model ${model} · lever ${leverBin}${Object.keys(leverEnv).length ? ` (${JSON.stringify(leverEnv)})` : ''} · saving to ${out}`)
    const rows = []
    const workers = Array.from({ length: Number(option('concurrency', 3)) }, async () => {
      while (jobs.length) {
        const row = await runOne(jobs.shift())
        rows.push(row)
        appendFileSync(out, `${JSON.stringify(row)}\n`)
        console.error(`${row.task} · ${row.way} · run ${row.repeat}: ${row.correct ? 'right' : `WRONG (${row.why})`} · ${row.rounds} model calls · ${row.calls} tool calls · ${row.seconds.toFixed(0)} s${row.errors.length ? ` · ${row.errors.length} tool errors` : ''}`)
      }
    })
    await Promise.all(workers)
    console.log(report(rows))
  }
}
