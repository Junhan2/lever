// Runs the stress tasks in interactive Claude Code sessions and records every run the way bench/stress/run.mjs does.
// Claude Code's own Code Mode (experimental) starts only in an interactive session in a terminal, so `claude -p` cannot
// measure it. This script starts each session in tmux and measures every way in that one kind of session: built-in
// tools, Code Mode, built-in tools and lever, lever only, and Code Mode with lever.
//   node bench/stress/terminal.mjs [--model haiku] [--repeats 3] [--ways built-in,code-mode,both,lever,code-mode+lever]
//                                  [--tasks follow-chain,bisect] [--concurrency 3] [--out runs.jsonl]
//                                  [--keep folder]   keeps a copy of every session's transcript in that folder
//                                  [--lever /path/to/bin/lever.mjs] [--lever-env LEVER_MAX_OUTPUT=8000]
//   node bench/stress/run.mjs --report runs.jsonl    prints the tables for saved runs
// Before you run it:
// - It needs tmux, and it uses your Claude Code account.
// - Sessions run in bypassPermissions mode, each in a generated project under the temp folder, without your user
//   settings and with a clean environment. The script answers two of Claude Code's first-run questions with yes:
//   "trust this folder" for its own project folders, and "turn on Code Mode". Claude Code keeps both answers.
// - The numbers come from each session's transcript. The script removes the transcript after it has read it.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { makeProject } from './project.mjs'
import { BUILT_IN, LEVER, WAYS, args, cleanEnv, option, report } from './run.mjs'
import { TASKS } from './tasks.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const REPL = 'REPL' // the tool that runs the code in Code Mode
const CONFIG = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
const SERVER = ['-L', `lever-bench-${process.pid}`, '-f', '/dev/null'] // a tmux server of our own, without the user's config
const ASKS = /Yes, (?:I trust this folder|turn on Code Mode|I accept)/
const READY = /bypass permissions on/ // the line under the input box of a session that has started
const SETTLE = 6000 // ms between a session being ready and its prompt
const tmux = (...rest) => execFileSync('tmux', [...SERVER, ...rest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const quote = text => `'${String(text).replaceAll("'", `'\\''`)}'`
const lastLines = screen => screen.split('\n').map(line => line.trim()).filter(Boolean).slice(-4).join(' / ').slice(0, 300)

/** What a session did, read from its transcript. Messages from the model carry `madeBy: "model"` and their usage. In
 * Code Mode, a tool call that the code makes is recorded as a message with `madeBy: "other"` and no usage, and the
 * result of a piece of code comes back as a `repl-eval` event. The lines of a transcript are not in the order of
 * their times: an event can stand before the call that it answers. */
export function readSession(file) {
  const session = { codeMode: false, leverReady: false, rounds: 0, input: 0, output: 0, tools: [], inner: [], errors: [], lever: [], code: [], answer: '', cost: null, seconds: 0, stop: 'none', waiting: 0, failed: null, done: false }
  let lines
  try {
    lines = readFileSync(file, 'utf8').split('\n')
  } catch {
    return session
  }
  const usage = new Map() // message id → usage
  const texts = new Map() // message id → its text
  const names = new Map() // tool call id → tool name
  const calls = new Map() // tool call id → the record of a lever or Code Mode call
  const evals = new Map() // Code Mode's number for a piece of code → its record
  const events = new Map() // that number → what the code gave back
  const inner = new Set() // the ids of the tool calls that code made
  const noteEvents = text => {
    for (const event of String(text ?? '').matchAll(/<event\b([^>]*\bkind="repl-eval"[^>]*)>([\s\S]*?)(?=<event\b[^>]*\bkind=|$)/g)) {
      const number = /\beval="(\d+)"/.exec(event[1])?.[1]
      if (number && !events.has(number)) events.set(number, { status: /\bstatus="([^"]+)"/.exec(event[1])?.[1] ?? '?', body: event[2].replace(/<\/event>\s*$/, '').trim() })
    }
  }
  let started = null
  let ended = null
  let last = null
  let lastAt = -1
  let turnEndAt = -1
  let firstAt = -1
  let leverAt = -1
  lines.forEach((line, index) => {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    if (entry.type === 'repl-mode') session.codeMode ||= entry.replMode === true
    else if (entry.type === 'cost-state') session.cost = entry.totalCostUSD ?? null
    else if (entry.type === 'system' && entry.subtype === 'turn_duration') {
      turnEndAt = index
      ended = entry.timestamp
    } else if (entry.type === 'queue-operation' && entry.operation === 'enqueue') noteEvents(entry.content)
    else if (entry.type === 'api-request-shape') {
      if (leverAt === -1 && (entry.shape?.tools ?? []).some(tool => tool?.name === LEVER)) leverAt = index
    } else if (entry.type === 'attachment') {
      const { type, addedNames = [], content = '', envelopes = [] } = entry.attachment ?? {}
      if (type === 'poll_events') envelopes.forEach(noteEvents)
      const here = (type === 'deferred_tools_delta' && addedNames.includes(LEVER)) || (type === 'repl_mcp_servers' && /connected servers are[^.]*"lever"/.test(content))
      if (here && leverAt === -1) leverAt = index
    } else if (entry.type === 'assistant' && entry.isApiErrorMessage) {
      session.failed = (entry.message?.content ?? []).map(block => block.text ?? '').join(' ').slice(0, 200)
    } else if (entry.type === 'assistant' && entry.message) {
      const message = entry.message
      const byModel = entry.madeBy ? entry.madeBy === 'model' : String(message.id).startsWith('msg_')
      if (byModel) {
        if (firstAt === -1) firstAt = index
        const before = usage.get(message.id)
        if (!before || (message.usage?.output_tokens ?? 0) >= (before.output_tokens ?? 0)) usage.set(message.id, message.usage ?? {})
        last = message
        lastAt = index
        ended = entry.timestamp
      }
      for (const block of message.content ?? []) {
        if (block.type === 'text' && byModel) texts.set(message.id, (texts.get(message.id) ?? '') + block.text)
        if (block.type !== 'tool_use') continue
        names.set(block.id, block.name)
        if (!byModel) inner.add(block.id)
        ;(byModel ? session.tools : session.inner).push(block.name)
        if (block.name !== LEVER && !(byModel && block.name === REPL)) continue
        const call = { code: String(block.input?.code ?? '').slice(0, 1500) }
        calls.set(block.id, call)
        ;(block.name === LEVER ? session.lever : session.code).push(call)
      }
    } else if (entry.type === 'user' && entry.message) {
      const content = entry.message.content
      if (started === null && typeof content === 'string') started = entry.timestamp
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== 'tool_result') continue
        const body = typeof block.content === 'string' ? block.content : (block.content ?? []).map(part => part.text ?? '').join(' ')
        const name = names.get(block.tool_use_id) ?? '?'
        if (name === 'Poll') noteEvents(body)
        // An error inside code is the code's to handle; what the model sees is whether the code as a whole failed.
        if (block.is_error && !inner.has(block.tool_use_id)) session.errors.push({ tool: name, text: body.slice(0, 400) })
        const call = calls.get(block.tool_use_id)
        if (!call) continue
        // Code Mode answers a call with "(dispatched #1)" and sends the result of that code later, as an event.
        const number = name === REPL && !block.is_error ? /\(dispatched #(\d+)\)/.exec(body)?.[1] : null
        if (number) evals.set(number, call)
        else Object.assign(call, { error: Boolean(block.is_error), reply: body.slice(0, 500), replyChars: body.length })
      }
    }
  })
  for (const one of usage.values()) {
    session.input += (one.input_tokens ?? 0) + (one.cache_creation_input_tokens ?? 0) + (one.cache_read_input_tokens ?? 0)
    session.output += one.output_tokens ?? 0
  }
  session.rounds = usage.size
  session.answer = last ? (texts.get(last.id) ?? '') : ''
  session.stop = last?.stop_reason ?? 'none'
  session.seconds = started && ended ? (Date.parse(ended) - Date.parse(started)) / 1000 : 0
  for (const [number, call] of evals) {
    const event = events.get(number)
    if (!event) {
      session.waiting += 1
      continue
    }
    const failed = event.status !== 'settled' || /^<error\b/.test(event.body)
    Object.assign(call, { error: failed, reply: event.body.slice(0, 500), replyChars: event.body.length })
    if (failed) session.errors.push({ tool: REPL, text: event.body.slice(0, 400) })
  }
  session.leverReady = leverAt !== -1 && (firstAt === -1 || leverAt < firstAt)
  // The turn is over when Claude Code has written its length after the model's last message, and no code still runs.
  session.done = session.stop !== 'none' && session.stop !== 'tool_use' && turnEndAt > lastAt && session.waiting === 0
  return session
}

async function runOne({ task, way, repeat, model, leverBin, leverEnv, dir, keep }) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  makeProject(dir, task.fixture)
  const work = mkdtempSync(path.join(os.tmpdir(), 'lever-terminal-run-'))
  const id = randomUUID()
  const name = `run-${id.slice(0, 8)}`
  const folder = path.join(CONFIG, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'))
  const transcript = path.join(folder, `${id}.jsonl`)
  const flags = ['--model', model, '--session-id', id, '--setting-sources', 'project,local', '--strict-mcp-config', '--permission-mode', 'bypassPermissions', '--settings', JSON.stringify({ skipDangerousModePermissionPrompt: true })]
  const after = way === 'lever' ? ['--disallowedTools', ...BUILT_IN] : []
  if (WAYS[way].lever) {
    // lever runs without the owner's own hooks, guards and config, like the rest of this clean setup
    const server = { command: process.execPath, args: [leverBin], env: { CLAUDE_PROJECT_DIR: dir, LEVER_HOOKS: 'off', LEVER_CONFIG: path.join(work, 'none.json'), ...leverEnv } }
    writeFileSync(path.join(work, 'mcp.json'), JSON.stringify({ mcpServers: { lever: server } }))
    after.unshift('--mcp-config', path.join(work, 'mcp.json'))
  }
  writeFileSync(path.join(work, 'prompt.txt'), task.prompt)
  const env = { ...cleanEnv(), TERM: 'xterm-256color', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: WAYS[way].codeMode ? '1' : '0' }
  const command = ['exec', 'env', '-i', ...Object.entries(env).map(pair => quote(pair.join('='))), 'claude', ...flags.map(quote), ...after.map(quote)]
  writeFileSync(path.join(work, 'start.sh'), `#!/bin/sh\ncd ${quote(dir)} || exit 97\n${command.join(' ')}\n`, { mode: 0o755 })
  tmux('new-session', '-d', '-s', name, '-x', '200', '-y', '50', quote(path.join(work, 'start.sh')))

  const pane = () => {
    try {
      return tmux('capture-pane', '-p', '-t', name)
    } catch {
      return null
    }
  }
  const gone = () => {
    try {
      return tmux('list-panes', '-t', name, '-F', '#{pane_dead}').trim() !== '0'
    } catch {
      return true
    }
  }
  const press = async (key, shown) => {
    tmux('send-keys', '-t', name, key)
    for (let tries = 0; tries < 20 && pane() === shown; tries++) await sleep(250) // one key for each screen: wait for the next one
  }
  const began = Date.now()
  let screen = ''
  let presses = 0
  let ready = null
  let sent = null
  let why = null
  let session = readSession(transcript)
  while (true) {
    await sleep(500)
    screen = pane() ?? screen
    if (ASKS.test(screen) && screen.includes('Enter to confirm') && presses < 12) {
      const chosen = screen.split('\n').find(line => line.includes('❯')) ?? ''
      await press(ASKS.test(chosen) ? 'Enter' : 'Down', screen)
      presses += 1
    } else if (sent === null) {
      // The prompt is typed the way a person types it: a while after the session opened. Sent with the command line,
      // it would go to the model before the MCP servers have connected, and the first model call would not know lever.
      if (gone()) why = `the session ended early: ${lastLines(screen)}`
      else if (ready === null && (READY.test(screen) || Date.now() - began > 60_000)) ready = Date.now()
      else if (ready !== null && Date.now() - ready >= SETTLE) {
        tmux('load-buffer', '-b', name, path.join(work, 'prompt.txt'))
        tmux('paste-buffer', '-d', '-p', '-b', name, '-t', name)
        await sleep(600)
        tmux('send-keys', '-t', name, 'Enter')
        sent = Date.now()
      }
    } else {
      session = readSession(transcript)
      if (session.done) break
      const quiet = existsSync(transcript) ? Date.now() - statSync(transcript).mtimeMs : 0
      if (session.stop !== 'none' && session.stop !== 'tool_use' && session.waiting === 0 && quiet > 10_000) break // a turn that ended without its length
      if (session.failed) why = `API error: ${session.failed}`
      else if (gone()) why = `the session ended early: ${lastLines(screen)}`
      else if (!existsSync(transcript) && Date.now() - sent > 30_000) why = `the session did not take the prompt: ${lastLines(screen)}`
      else if (Date.now() - sent > 900_000) why = `no answer after 15 minutes: ${lastLines(screen)}`
    }
    if (why) break
  }
  // Leaving through /exit lets the session write what it cost.
  try {
    tmux('send-keys', '-t', name, '/exit')
    await sleep(400)
    tmux('send-keys', '-t', name, 'Enter')
    for (let tries = 0; tries < 40 && !gone(); tries++) await sleep(250)
    tmux('kill-session', '-t', name)
  } catch {}
  session = readSession(transcript)
  // Subagents write their own transcripts; their model calls and tokens count too.
  const helpers = path.join(folder, id, 'subagents')
  const subagents = existsSync(helpers) ? readdirSync(helpers).filter(file => file.endsWith('.jsonl')).map(file => readSession(path.join(helpers, file))) : []
  for (const helper of subagents) for (const key of ['rounds', 'input', 'output']) session[key] += helper[key]

  let verdict
  try {
    if (why) verdict = why
    else if (session.codeMode !== Boolean(WAYS[way].codeMode)) verdict = `Code Mode was ${session.codeMode ? 'on' : 'off'} in this session: ${lastLines(screen)}`
    else if (WAYS[way].lever && !session.leverReady) verdict = 'lever had not connected when the prompt went to the model'
    else verdict = task.check(dir, session.answer)
  } catch (error) {
    verdict = `checker failed: ${error.message}`
  }
  if (keep && existsSync(transcript)) copyFileSync(transcript, path.join(keep, `${task.key}.${way}.${repeat}.jsonl`))
  rmSync(transcript, { force: true })
  rmSync(path.join(folder, id), { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  return {
    task: task.key,
    way,
    model,
    repeat,
    harness: 'terminal',
    settings: Object.entries(leverEnv).map(pair => pair.join('=')).join(' '),
    correct: verdict === true,
    why: verdict === true ? null : String(verdict).slice(0, 300),
    codeMode: session.codeMode,
    leverReady: WAYS[way].lever ? session.leverReady : null,
    rounds: session.rounds,
    calls: session.tools.length,
    tools: session.tools,
    inner: session.inner,
    subagents: subagents.length,
    usedLever: session.tools.includes(LEVER) || session.inner.includes(LEVER),
    input: session.input,
    output: session.output,
    cost: session.cost,
    seconds: session.seconds,
    stop: session.stop,
    errors: session.errors,
    lever: session.lever,
    code: session.code,
    answer: session.answer.slice(0, 300),
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const model = option('model', 'haiku')
  const repeats = Number(option('repeats', 3))
  const ways = option('ways', 'built-in,code-mode,both,lever,code-mode+lever').split(',')
  const other = ways.find(way => !WAYS[way])
  if (other) {
    console.error(`${other}: no such way`)
    process.exit(1)
  }
  const wanted = option('tasks')?.split(',')
  const tasks = TASKS.filter(task => !wanted || wanted.includes(task.key))
  const out = option('out', path.join(os.tmpdir(), `lever-terminal-${Date.now()}.jsonl`))
  const keep = option('keep') && path.resolve(option('keep'))
  if (keep) mkdirSync(keep, { recursive: true })
  const leverBin = path.resolve(option('lever', path.join(ROOT, 'bin', 'lever.mjs')))
  const leverEnv = Object.fromEntries(args.flatMap((arg, index) => (args[index - 1] === '--lever-env' ? [[arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]] : [])))
  const jobs = []
  for (let repeat = 1; repeat <= repeats; repeat++) for (const task of tasks) for (const way of ways) jobs.push({ task, way, repeat, model, leverBin, leverEnv, keep })
  // Every worker has one project folder of its own and fills it again for each run, so Claude Code asks about trust once.
  const slots = path.join(realpathSync(os.tmpdir()), 'lever-terminal')
  const folders = Array.from({ length: Math.min(Number(option('concurrency', 3)), jobs.length) }, (_, index) => path.join(slots, `slot-${index + 1}`))
  console.error(`${jobs.length} runs in terminal sessions · model ${model} · lever ${leverBin}${Object.keys(leverEnv).length ? ` (${JSON.stringify(leverEnv)})` : ''} · saving to ${out}`)
  tmux('new-session', '-d', '-s', 'keep', '-x', '200', '-y', '50', 'sleep 2000000', ';', 'set-option', '-g', 'remain-on-exit', 'on')
  const stopServer = () => {
    try {
      tmux('kill-server')
    } catch {}
  }
  process.on('exit', stopServer)
  process.on('SIGINT', () => process.exit(130))
  const rows = []
  let refused = 0
  await Promise.all(
    folders.map(async dir => {
      while (jobs.length) {
        const row = await runOne({ ...jobs.shift(), dir })
        rows.push(row)
        refused = row.why?.startsWith('API error') ? refused + 1 : 0
        if (refused >= 3 && jobs.length) {
          console.error(`three runs in a row ended in an API error; the ${jobs.length} runs left are not started`)
          jobs.length = 0
        }
        appendFileSync(out, `${JSON.stringify(row)}\n`)
        console.error(`${row.task} · ${row.way} · run ${row.repeat}: ${row.correct ? 'right' : `WRONG (${row.why})`} · ${row.rounds} model calls · ${row.calls} tool calls · ${row.seconds.toFixed(0)} s${row.errors.length ? ` · ${row.errors.length} tool errors` : ''}`)
      }
    }),
  )
  stopServer()
  rmSync(slots, { recursive: true, force: true })
  // Claude Code made a folder for each project folder in its history. With the transcripts gone it holds an empty
  // "memory" folder at most; rmdir removes only what is empty.
  for (const dir of folders) {
    const folder = path.join(CONFIG, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'))
    for (const empty of [path.join(folder, 'memory'), folder]) {
      try {
        rmdirSync(empty)
      } catch {}
    }
  }
  console.log(report(rows))
}
