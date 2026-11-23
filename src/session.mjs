// One session: the code context with its helpers, the runs, and the replies they produce. It lives inside the worker
// thread (worker.mjs); tests use it directly.
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { formatWithOptions } from 'node:util'
import { help } from './docs.mjs'
import { createEvaluator, lastStatement } from './evaluate.mjs'
import { bytes, capReply, cutMiddle, errorText, isShellResult, render, renderWithin, seconds, settle, shellText, short } from './format.mjs'
import { createGuard } from './guard.mjs'
import { createFiles, fingerprint } from './helpers/files.mjs'
import { createSearch } from './helpers/search.mjs'
import { createShell } from './helpers/shell.mjs'

const LOG_CAP = 1024 * 1024
const KEEP_HISTORY = 20
const KEEP_JOBS = 50
const KEEP_NAMES = 2000
// import('./file.mjs') and `import x from './file.mjs'`: project files, not packages
const FILE_IMPORTS = /\bimport\s*\(\s*(['"`])(\.{0,2}\/[^'"`]+)\1\s*\)|^\s*import\s[^'"\n]*?(['"])(\.{0,2}\/[^'"]+)\3/gm
// names a run declares: `const a`, `function b`, and the names inside `const { c, d: e } =` or `const [f] =`
const DECLARED = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s*[{[]([^;]{0,400}?)[}\]]\s*=/g

class RunStopped extends Error {
  constructor(message) {
    super(message)
    this.name = 'RunStopped'
  }
}

/** events: { onChild(pid, added), onStep(runId, step), mcp(env) → mcp object } */
export function createSession(config, events = {}) {
  const als = new AsyncLocalStorage()
  const runs = new Map()
  const history = []
  const earlier = new Set() // names earlier runs declared, to explain "x is not defined"
  const strays = [] // errors code left behind: thrown by a timer or an event, or a promise nobody awaited
  const imported = new Map() // project files code has imported, with their change time at the first import

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
      loose: new Set(), // helper calls whose result nobody has awaited yet (see exists)
      journal: new Map(),
      bytesIn: 0,
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

  // Logs are kept whole (up to LOG_CAP a run); the reply cuts them, like the returned value, only when it has to.
  const show = value => (isShellResult(value) ? shellText(value, Infinity) : value)
  const logger = level => (...args) => {
    const run = als.getStore() ?? outside
    const room = LOG_CAP - run.logSize
    if (room <= 0) {
      run.logsDropped++
      return
    }
    const text = cutMiddle(formatWithOptions({ depth: 4, maxArrayLength: 100, maxStringLength: Infinity, breakLength: 160 }, ...args.map(show)), room)
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

  const helpers = {
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
  }
  const { evaluate } = createEvaluator(helpers, { dir: config.projectDir })

  function noteDeclared(code) {
    for (const match of code.matchAll(DECLARED)) {
      const names = match[1] ? [match[1]] : match[2].split(',').map(part => part.split(':').pop().split('=')[0].replace('...', '').trim())
      for (const name of names) if (earlier.size < KEEP_NAMES && /^[A-Za-z_$][\w$]*$/.test(name)) earlier.add(name)
    }
  }

  /** Node keeps the first copy of a module it imports. When code imports a project file again after the file changed,
   * it gets the old code without any sign of it; this adds the sign. */
  function noteStaleImports(run, code) {
    for (const match of code.matchAll(FILE_IMPORTS)) {
      const file = path.resolve(config.projectDir, match[2] ?? match[4])
      let changed
      try {
        changed = statSync(file).mtimeMs
      } catch {
        continue
      }
      const first = imported.get(file)
      if (first === undefined) imported.set(file, changed)
      else if (changed > first) run.note([`${path.relative(config.projectDir, file)} changed after this session first imported it, and import() keeps the copy it loaded first. To run the new code, start a process: $\`node …\``])
    }
  }

  /** What to do about an error that code written for other tools runs into here, or null. */
  function hintFor(error) {
    const message = String(error?.message ?? '')
    if (error?.name === 'ReferenceError') {
      const hidden = /^Cannot access '([^']+)' before initialization$/.exec(message)?.[1]
      if (hidden && Object.hasOwn(helpers, hidden)) return `"${hidden}" is a helper, and a const or let with the same name hides it in this run. Give the variable another name.`
      const missing = /^([\w$]+) is not defined$/.exec(message)?.[1]
      if (missing && earlier.has(missing)) return `"${missing}" was declared in an earlier run. Each run has its own scope: keep values for later runs on state (state.${missing} = …).`
    }
    if (error?.name === 'TypeError' && /^\$\(\.\.\.\)\.[\w$]+ is not a function$/.test(message)) {
      return '$ chains .nothrow() .cwd(dir) .env({…}) .timeout(ms) .input(text) .quiet(), then .text() .lines() .json().'
    }
    return null
  }

  function remember(run) {
    if (run.journal.size === 0) return
    const after = new Map()
    for (const file of run.journal.keys()) after.set(file, existsSync(file) ? fingerprint(readFileSync(file)) : null)
    history.push({ id: run.id, journal: run.journal, after })
    if (history.length > KEEP_HISTORY) history.shift()
  }

  function describeError(error, code, filename) {
    if (error?.name === 'RunStopped') return `Stopped: ${error.message}`
    let text = errorText(error)
    const hint = hintFor(error)
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
    return hint ? `${text}\n  hint: ${hint}` : text
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
    if (run.loose.size) {
      const calls = [...new Set([...run.loose].map(call => call.label))]
      lines.push(`note: ${calls.slice(0, 3).join(', ')} ${calls.length === 1 ? 'was' : 'were'} called without await, so the result was never read (a promise is always truthy). Write: await exists(path)`)
    }
    for (const text of strays.splice(0)) lines.push(`note: thrown outside the awaited code (by a timer, an event, or a promise without await): ${text}`)
    return lines.join('\n')
  }

  /** The reply of a run that has nothing to show. It says so in a way that tells an empty result (a filter that matched
   * nothing) from no result, and says why when the code ends with a declaration. */
  function nothingReturned(code, error, value) {
    if (value === '') return '(done: the code returned an empty string)'
    const range = error ? null : lastStatement(code)
    const declares = range && /^(?:const|let|var)\s/.test(code.slice(range.start, range.end))
    return declares ? '(done, nothing returned: the code ends with a declaration. End with the value, or return it, to see a result.)' : '(done, nothing returned)'
  }

  function compose(run, code, filename, value, error) {
    const logs = run.logs.length ? run.logs.join('\n') + (run.logsDropped ? `\n…[${run.logsDropped} more log lines dropped]` : '') : ''
    // The value gets the room the logs leave, and long strings inside it are cut only as much as that needs.
    const result = error ? { text: describeError(error, code, filename) } : renderWithin(value, Math.max(1000, config.maxOutput - logs.length))
    const body = text => [logs, text].filter(Boolean).join('\n') || nothingReturned(code, error, value)
    const capped = capReply(body(result.text), { maxOutput: config.maxOutput, spillDir: config.spillDir, label: `run-${process.pid}-${run.id}`, whole: body(result.whole ?? result.text) })
    const footer = summary(run, Buffer.byteLength(capped.text))
    return { text: footer ? `${capped.text}\n---\n${footer}` : capped.text, isError: Boolean(error), file: capped.file }
  }

  async function execute(run, code, timeoutMs) {
    let value
    let error = null
    let filename = null
    let onAbort
    const stopped = new Promise((_, reject) => {
      onAbort = () => reject(new RunStopped(String(run.signal.reason ?? 'stopped')))
      run.signal.addEventListener('abort', onAbort, { once: true })
    })
    stopped.catch(() => {})
    try {
      noteStaleImports(run, code)
      const job = evaluate(code, { timeoutMs })
      filename = job.filename
      if (job.repaired) run.note(['the code had backticks escaped outside a string ($\\`…\\`), which is not JavaScript; it ran with those backslashes removed'])
      value = await Promise.race([job.promise.then(result => settle(result)), stopped])
    } catch (thrown) {
      error = thrown ?? new Error('the code threw undefined')
    } finally {
      run.signal.removeEventListener('abort', onAbort)
    }
    // one turn of the event loop, so a promise this code rejected without awaiting it is reported in this reply
    await new Promise(resolve => setImmediate(resolve))
    remember(run)
    const reply = compose(run, code, filename, value, error)
    noteDeclared(code)
    return reply
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
        // a finished job keeps only what jobs.list and stop read, not its logs, steps and file copies
        entry.run = { steps: record.steps.slice(-1), abort: record.abort }
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

  /** Keeps an error that reached the thread from outside any awaited code, for the next reply to show. */
  function stray(error) {
    if (strays.length < 5) strays.push(short(errorText(error), 300))
  }

  return { run, stop, detach, close, stray, jobs, env }
}
