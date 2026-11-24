// Runs the stress tasks in Grok Build (`grok -p`) and records every run the way bench/stress/run.mjs does. Two ways:
// with Grok's own tools only, and with lever among Grok's MCP servers, which is how an install looks.
//   node bench/stress/grok.mjs [--model grok-4.7] [--effort xhigh] [--repeats 3] [--ways built-in,both]
//                              [--tasks follow-chain,bisect] [--concurrency 3] [--out runs.jsonl]
//                              [--rules "text"]   a rule for the runs with lever (Grok finds lever without one)
//   node bench/stress/run.mjs --report runs.jsonl   prints the tables for saved runs
// Before you run it:
// - Grok must see lever as an MCP server named "lever": `grok mcp add lever node -- /path/to/bin/lever.mjs`, or a
//   server of that name in ~/.claude.json, which Grok reads too.
// - For the runs without lever the script switches lever off in your Grok config (`grok mcp disable lever`), and on
//   again when they are done, also when it is interrupted. If lever stays off: `grok mcp enable lever`.
// - Runs use your Grok account, approve every tool call (--always-approve) and leave Grok's memory out. Grok keeps
//   each run as a session, filed in ~/.grok/sessions under the script's folders in the temp folder.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeProject } from './project.mjs'
import { LEVER, WAYS, cleanEnv, option, report } from './run.mjs'
import { TASKS } from './tasks.mjs'

const SERVER = 'lever'
const RUN = `${SERVER}__run` // lever's tool as Grok names it
const CONFIG = path.join(os.homedir(), '.grok', 'config.toml')
const grok = (...rest) => execFileSync('grok', rest, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() })
const isOff = () => {
  try {
    return /^\s*disabled_mcp_servers\s*=.*"lever"/m.test(readFileSync(CONFIG, 'utf8'))
  } catch {
    return false
  }
}

function runOne({ task, way, repeat, model, effort, rules, dir }) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  makeProject(dir, task.fixture)
  const flags = ['-p', task.prompt, '--model', model, '--reasoning-effort', effort, '--output-format', 'streaming-messages-json', '--always-approve', '--no-memory', '--max-turns', '40']
  if (WAYS[way].lever && rules) flags.push('--rules', rules)
  const started = Date.now()
  return new Promise(resolve => {
    const child = spawn('grok', flags, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (err = (err + chunk).slice(-2000)))
    const timer = setTimeout(() => child.kill('SIGKILL'), 1_800_000)
    child.on('close', () => {
      clearTimeout(timer)
      const names = new Map()
      const tools = []
      const errors = []
      const rounds = new Set()
      const leverCalls = new Map()
      let listed = null
      let result = null
      for (const line of out.split('\n')) {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'system' && event.subtype === 'init') listed = (event.mcp_servers ?? []).some(server => (server?.name ?? server) === SERVER)
        if (event.type === 'assistant' && event.message?.id) rounds.add(event.message.id)
        const content = Array.isArray(event.message?.content) ? event.message.content : []
        for (const block of content) {
          if (block.type === 'tool_use') {
            // Grok calls an MCP tool through its own use_tool. The record gives lever's tool the name the other scripts use.
            const name = block.name === 'use_tool' && block.input?.tool_name === RUN ? LEVER : block.name
            names.set(block.id, name)
            tools.push(name)
            if (name === LEVER) leverCalls.set(block.id, { code: String(block.input?.tool_input?.code ?? '').slice(0, 1500) })
          } else if (block.type === 'tool_result') {
            const name = names.get(block.tool_use_id) ?? '?'
            let text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
            let failed = Boolean(block.is_error)
            if (name === LEVER) {
              // Grok wraps an MCP result: {"type":"MCP",…,"output":{"OkayOutput":"…"}}; anything else is a failed run.
              try {
                const output = JSON.parse(text).output ?? {}
                if (typeof output.OkayOutput === 'string') text = output.OkayOutput
                else {
                  failed = true
                  text = typeof Object.values(output)[0] === 'string' ? Object.values(output)[0] : JSON.stringify(output)
                }
              } catch {}
            }
            if (failed) errors.push({ tool: name, text: text.slice(0, 400) })
            const call = leverCalls.get(block.tool_use_id)
            if (call) Object.assign(call, { error: failed, reply: text.slice(0, 500), replyChars: text.length })
          }
        }
        if (event.type === 'result') result = event
      }
      const usage = result?.usage ?? {}
      const answer = String(result?.result ?? '')
      let verdict
      try {
        if (!result) verdict = `no result (${err.trim().split('\n').at(-1) ?? 'no output'})`
        else if (!WAYS[way].lever && tools.includes(LEVER)) verdict = 'lever was used in a run that should be without it'
        else if (WAYS[way].lever && listed === false) verdict = 'the session did not list lever among its MCP servers'
        else verdict = task.check(dir, answer)
      } catch (error) {
        verdict = `checker failed: ${error.message}`
      }
      resolve({
        task: task.key,
        way,
        model,
        repeat,
        harness: 'grok',
        settings: [`effort=${effort}`, ...(WAYS[way].lever && rules ? ['rules'] : [])].join(' '),
        correct: verdict === true,
        why: verdict === true ? null : String(verdict).slice(0, 300),
        leverListed: listed,
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const model = option('model', 'grok-4.7')
  const effort = option('effort', 'xhigh')
  const repeats = Number(option('repeats', 3))
  const rules = option('rules', '')
  const ways = ['built-in', 'both'].filter(way => option('ways', 'built-in,both').split(',').includes(way))
  if (!ways.length) {
    console.error('--ways takes built-in and both')
    process.exit(1)
  }
  const wanted = option('tasks')?.split(',')
  const tasks = TASKS.filter(task => !wanted || wanted.includes(task.key))
  const out = option('out', path.join(os.tmpdir(), `lever-grok-${Date.now()}.jsonl`))
  const wasOff = isOff()
  if (wasOff && ways.includes('both')) {
    console.error('lever is switched off in your Grok config. Switch it on first: grok mcp enable lever')
    process.exit(1)
  }
  const restore = () => {
    try {
      if (!wasOff && isOff()) grok('mcp', 'enable', SERVER)
    } catch {}
  }
  process.on('exit', restore)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(1))
  const slots = path.join(realpathSync(os.tmpdir()), 'lever-grok')
  const folders = Array.from({ length: Number(option('concurrency', 3)) }, (_, index) => path.join(slots, `slot-${index + 1}`))
  console.error(`${ways.length * tasks.length * repeats} runs in Grok Build · model ${model} · effort ${effort}${rules ? ' · with a rule for lever' : ''} · saving to ${out}`)
  const rows = []
  for (const way of ways) {
    // One way after the other: whether Grok has lever is a setting of the whole account, not of one run.
    if (!WAYS[way].lever && !isOff()) grok('mcp', 'disable', SERVER)
    if (WAYS[way].lever && isOff()) grok('mcp', 'enable', SERVER)
    const jobs = []
    for (let repeat = 1; repeat <= repeats; repeat++) for (const task of tasks) jobs.push({ task, way, repeat, model, effort, rules })
    await Promise.all(
      folders.map(async dir => {
        while (jobs.length) {
          const row = await runOne({ ...jobs.shift(), dir })
          rows.push(row)
          appendFileSync(out, `${JSON.stringify(row)}\n`)
          console.error(`${row.task} · ${row.way} · run ${row.repeat}: ${row.correct ? 'right' : `WRONG (${row.why})`} · ${row.rounds} model calls · ${row.calls} tool calls · ${row.seconds.toFixed(0)} s${row.errors.length ? ` · ${row.errors.length} tool errors` : ''}`)
        }
      }),
    )
  }
  restore()
  rmSync(slots, { recursive: true, force: true })
  console.log(report(rows))
}
