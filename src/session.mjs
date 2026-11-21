// One session: the code context with its helpers, the runs, and the replies they produce. It lives inside the worker
// thread (worker.mjs); tests use it directly.
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { formatWithOptions } from 'node:util'
import { help } from './docs.mjs'
import { createEvaluator } from './evaluate.mjs'
import { bytes, capReply, errorText, isShellResult, render, seconds, settle, shellText } from './format.mjs'
import { createGuard } from './guard.mjs'
import { createFiles } from './helpers/files.mjs'
import { createSearch } from './helpers/search.mjs'
import { createShell } from './helpers/shell.mjs'

const LOG_CAP = 1024 * 1024
const KEEP_HISTORY = 20
const KEEP_JOBS = 50

export class RunStopped extends Error {
  constructor(message) {
    super(message)
    this.name = 'RunStopped'
  }
}

const short = (text, max = 60) => {
  const line = String(text).replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** events: { onChild(pid, added), onStep(runId, step), mcp(env) → mcp object } */
export function createSession(config, events = {}) {
  const als = new AsyncLocalStorage()
  const runs = new Map()
  const history = []

  function newRun(id) {
    const controller = new AbortController()
    return {
      id,
      startedAt: Date.now(),
      logs: [],
      logSize: 0,
      logsDropped: 0,
      steps: [],
      notes: [],
      journal: new Map(),
      bytesIn: 0,
      children: new Set(),
      signal: controller.signal,
      abort(reason) {
        if (!controller.signal.aborted) controller.abort(reason)
      },
      note(list) {
        for (const item of list ?? []) {
          const text = String(item).trim().slice(0, 600)
          if (text && !this.notes.includes(text)) this.notes.push(text)
        }
      },
      step(step) {
        this.steps.push(step)
        events.onStep?.(id, step)
      },
    }
  }

  const outside = newRun('0') // for helpers called after their run has been forgotten
  const env = {
    projectDir: config.projectDir,
    guard: createGuard({ projectDir: config.projectDir, hooks: config.hooks, guards: config.guards }),
    shell: config.shell,
    rg: config.rg,
    spillDir: config.spillDir,
    history,
    onChild: events.onChild,
    run() {
      const run = als.getStore() ?? outside
      if (run.signal.aborted) throw new RunStopped(`run ${run.id} was stopped (${run.signal.reason ?? 'stopped'})`)
      return run
    },
  }

  const $ = createShell(env)
  const files = createFiles(env)
  const search = createSearch(env)
  const mcp = events.mcp?.(env)

  const show = value => (isShellResult(value) ? shellText(value) : value)
  const logger = level => (...args) => {
    const run = als.getStore() ?? outside
    const text = formatWithOptions({ depth: 4, maxArrayLength: 100, maxStringLength: 20_000, breakLength: 160 }, ...args.map(show))
    if (run.logSize + text.length > LOG_CAP) {
      run.logsDropped++
      return
    }
    run.logSize += text.length
    run.logs.push(level ? `[${level}] ${text}` : text)
  }
  const console = {
    log: logger(''),
    info: logger(''),
    debug: logger(''),
    warn: logger('warn'),
    error: logger('error'),
    trace: logger('trace'),
    dir: value => logger('')(value),
    table: data => logger('')(render(data)),
    assert: (condition, ...rest) => {
      if (!condition) logger('error')('Assertion failed', ...rest)
    },
  }
  const processView = Object.freeze({
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    version: process.version,
    versions: process.versions,
    pid: process.pid,
    cwd: () => config.projectDir,
    hrtime: process.hrtime,
    memoryUsage: () => process.memoryUsage(),
    nextTick: (fn, ...args) => process.nextTick(fn, ...args),
    exit: () => {
      throw new Error('process.exit() is not available inside a run: return a value or throw instead')
    },
  })

  const jobs = {
    list() {
      return [...runs.values()]
        .filter(entry => entry.detached)
        .map(entry => ({
          id: entry.id,
          status: entry.status,
          seconds: Math.round(((entry.endedAt ?? Date.now()) - entry.startedAt) / 1000),
          last: entry.run.steps.length ? short(entry.run.steps.at(-1).label, 80) : null,
        }))
    },
    /** Waits up to `ms`; by default as long as the client lets this run wait (30 s when it has no limit). */
    async wait(id, ms) {
      const entry = runs.get(String(id))
      const deadline = als.getStore()?.deadline
      ms ??= deadline ? Math.max(0, deadline - Date.now() - 500) : 30_000
      if (!entry) throw new Error(`No job ${id}. jobs.list() shows the jobs.`)
      if (entry.status === 'running') {
        let timer
        const finished = await Promise.race([
          entry.promise.then(() => true),
          new Promise(resolve => {
            timer = setTimeout(resolve, ms, false)
          }),
        ])
        clearTimeout(timer)
        if (!finished) {
          const last = entry.run.steps.at(-1)
          return `job ${id} is still running (${seconds(Date.now() - entry.startedAt)}${last ? `, last step: ${short(last.label)}` : ''}). Call jobs.wait(${id}) again later.`
        }
      }
      return entry.reply.text
    },
    cancel(id) {
      const entry = runs.get(String(id))
      if (!entry) throw new Error(`No job ${id}. jobs.list() shows the jobs.`)
      if (entry.status === 'running') stop(entry.id, 'cancelled by jobs.cancel')
      return `job ${id}: ${entry.status === 'running' ? 'stopping' : entry.status}`
    },
  }

  const { evaluate } = createEvaluator(
    {
      $,
      read: files.read,
      write: files.write,
      edit: files.edit,
      exists: files.exists,
      ls: files.ls,
      undo: files.undo,
      glob: search.glob,
      grep: search.grep,
      mcp,
      jobs,
      state: {},
      help,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      console,
      process: processView,
      require: createRequire(path.join(config.projectDir, 'package.json')),
    },
    { dir: config.projectDir },
  )

  async function remember(run) {
    if (run.journal.size === 0) return
    const after = new Map()
    for (const file of run.journal.keys()) after.set(file, existsSync(file) ? readFileSync(file) : null)
    history.push({ id: run.id, journal: run.journal, after })
    if (history.length > KEEP_HISTORY) history.shift()
  }

  function describeError(error, code, filename) {
    if (error?.name === 'RunStopped') return `Stopped: ${error.message}`
    let text = errorText(error)
    const name = filename ? path.basename(filename).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null
    const at = name ? new RegExp(`${name}:(\\d+)`).exec(String(error?.stack ?? '')) : null
    if (at) {
      const line = Number(at[1])
      const lines = code.split('\n')
      const source = lines[line - 1]
      if (source !== undefined) text += `\n  at line ${line}: ${short(source, 160)}`
      // A line that starts with ( [ or ` continues the line before it when that one has no semicolon.
      const before = lines.slice(0, line - 1).reverse().find(l => l.trim() !== '')
      if (source !== undefined && /^\s*[([`]/.test(source) && before !== undefined && !/[;{}]\s*$/.test(before.trim())) {
        text += `\n  hint: line ${line} starts with "${source.trim()[0]}" and the line before has no ";", so JavaScript reads them as one expression. Add ";" or use return.`
      }
    }
    return text
  }

  function summary(run, returned) {
    const counts = new Map()
    const failed = []
    const refused = []
    for (const step of run.steps) {
      counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1)
      if (step.detail === 'refused') refused.push(`${step.kind} ${short(step.label)}`)
      else if (!step.ok && !step.quiet) failed.push(`${step.kind} ${short(step.label)} (${step.detail})`)
    }
    const lines = []
    if (run.steps.length) {
      const kinds = [...counts].map(([kind, n]) => `${n} ${kind}`).join(', ')
      lines.push(`${kinds} · read ${bytes(run.bytesIn)}, returned ${bytes(returned)} · ${seconds(Date.now() - run.startedAt)}`)
    }
    const list = (label, items) => {
      if (items.length) lines.push(`${label}: ${items.slice(0, 5).join('; ')}${items.length > 5 ? ` (+${items.length - 5} more)` : ''}`)
    }
    list('failed', failed)
    list('refused', refused)
    const changed = [...run.journal.keys()].map(file => path.relative(config.projectDir, file) || file)
    if (changed.length) lines.push(`changed: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ` (+${changed.length - 10} more)` : ''} · undo() puts them back`)
    for (const note of run.notes) lines.push(`note: ${note}`)
    return lines.join('\n')
  }

  function compose(run, code, filename, value, error) {
    const parts = []
    if (run.logs.length) parts.push(run.logs.join('\n') + (run.logsDropped ? `\n…[${run.logsDropped} more log lines dropped]` : ''))
    if (error) parts.push(describeError(error, code, filename))
    else {
      const text = render(value)
      if (text !== '') parts.push(text)
    }
    const body = parts.join('\n') || '(done, nothing returned)'
    const capped = capReply(body, { maxOutput: config.maxOutput, spillDir: config.spillDir, label: `run-${process.pid}-${run.id}` })
    const footer = summary(run, Buffer.byteLength(capped.text))
    return { text: footer ? `${capped.text}\n---\n${footer}` : capped.text, isError: Boolean(error), file: capped.file }
  }

  async function execute(run, code, timeoutMs) {
    let value
    let error = null
    let filename = null
    const stopped = new Promise((_, reject) => {
      run.signal.addEventListener('abort', () => reject(new RunStopped(String(run.signal.reason ?? 'stopped'))), { once: true })
    })
    stopped.catch(() => {})
    try {
      const job = evaluate(code, { timeoutMs })
      filename = job.filename
      value = await Promise.race([job.promise.then(result => settle(result)), stopped])
    } catch (thrown) {
      error = thrown ?? new Error('the code threw undefined')
    }
    await remember(run)
    return compose(run, code, filename, value, error)
  }

  /** Runs code and resolves to its reply { text, isError, file }. Never rejects. */
  function run(id, code, { timeoutMs = config.timeoutMs, softLimitMs = null } = {}) {
    const record = newRun(String(id))
    record.deadline = softLimitMs ? record.startedAt + softLimitMs : null
    const entry = { id: String(id), status: 'running', startedAt: record.startedAt, run: record, detached: false, reply: null }
    runs.set(entry.id, entry)
    for (const [key, old] of runs) {
      if (runs.size <= KEEP_JOBS) break
      if (old.status !== 'running') runs.delete(key)
    }
    entry.promise = als
      .run(record, () => execute(record, code, timeoutMs))
      .catch(error => ({ text: `Internal error: ${errorText(error)}`, isError: true, file: null }))
      .then(reply => {
        entry.reply = reply
        entry.status = record.signal.aborted ? 'stopped' : reply.isError ? 'failed' : 'done'
        entry.endedAt = Date.now()
        return reply
      })
    return entry.promise
  }

  /** Stops a run: its commands and what they started are ended, and the run replies with what it has so far. */
  function stop(id, reason = 'stopped') {
    runs.get(String(id))?.run.abort(reason)
  }

  /** The client stopped waiting; the run goes on as a job. */
  function detach(id) {
    const entry = runs.get(String(id))
    if (entry) entry.detached = true
  }

  async function close() {
    for (const entry of runs.values()) entry.run.abort('the session closed')
    await mcp?.close?.()
  }

  return { run, stop, detach, close, jobs, env }
}
