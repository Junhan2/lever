// $`cmd ${value}`: runs a shell command as a step. Interpolated values are quoted; arrays become several arguments.
// The promise starts on the next microtask, so `.nothrow()`, `.cwd(dir)` or `.timeout(ms)` chained right away still apply.
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OUTPUT_CAP = 16 * 1024 * 1024
const SAFE = /^[\w@%+=:,./-]+$/
const OPTIONS = ['cwd', 'env', 'timeout', 'nothrow', 'input', 'quiet']

const isFolder = dir => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export function quote(value) {
  if (value === null || value === undefined) return "''"
  const text = String(value)
  if (text !== '' && SAFE.test(text)) return text
  if (process.platform === 'win32') return `"${text.replace(/"/g, '""')}"`
  return `'${text.replace(/'/g, "'\\''")}'`
}

class ShellError extends Error {
  constructor(result) {
    const status = result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`
    // Both ends can matter: npm writes its own note to stderr while the test report is on stdout.
    const err = (result.stderr ?? '').trim()
    const out = (result.stdout ?? '').trim()
    const parts = [`Command failed (${status}): ${result.command}`]
    if (err && out) parts.push(`stderr (end):\n${err.slice(-1500)}`, `stdout (end):\n${out.slice(-2500)}`)
    else if (err || out) parts.push((err || out).slice(-2500))
    super(parts.join('\n'))
    this.name = 'ShellError'
    this.result = result
  }
}

class StepRefused extends Error {
  constructor(step, reason) {
    super(`Refused ${step}: ${reason}`)
    this.name = 'StepRefused'
  }
}

/** Runs the checks for one step (guards, permission rules, PreToolUse hooks). A refusal is recorded as a step and
 * thrown as StepRefused; otherwise it returns the verdict, whose `input` a hook may have replaced. */
export async function checkStep(env, run, tool, input, label, { kind = tool.toLowerCase(), name = `${tool} ${label}` } = {}) {
  const verdict = await env.guard.before(tool, input)
  run.note(verdict.notes)
  if (verdict.deny) {
    run.step({ kind, label, ok: false, detail: 'refused' })
    throw new StepRefused(name, verdict.deny)
  }
  return verdict
}

/** Hands the complete lines in a text chunk to onLine and returns the unfinished end, to pass back in as `rest` with the
 * next chunk. Only the new chunk is scanned, so a long line that arrives in many chunks stays linear. onLine may
 * return false to stop; eachLine then returns null. */
export function eachLine(rest, chunk, onLine) {
  let start = 0
  for (let at = chunk.indexOf('\n'); at !== -1; at = chunk.indexOf('\n', start)) {
    const line = rest + chunk.slice(start, at)
    rest = ''
    start = at + 1
    if (onLine(line) === false) return null
  }
  return rest + chunk.slice(start)
}

/** Home-relative paths (~ and ~/...) as absolute ones. */
export const expandHome = input => (input === '~' || input.startsWith('~/') ? path.join(os.homedir(), input.slice(1)) : input)

export function pickShell(preferred) {
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: command => ['/d', '/s', '/c', command] }
  const file = preferred || ['/bin/bash', '/usr/bin/bash', '/bin/sh'].find(candidate => existsSync(candidate)) || '/bin/sh'
  return { file, args: command => ['-c', command] }
}

/** Ends a process and everything it started (it leads its own process group). */
export function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

function makeResult(command, fields) {
  const result = {
    __lever: 'shell',
    command,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    ms: 0,
    ...fields,
  }
  result.ok = result.exitCode === 0
  Object.defineProperty(result, 'toString', { value: () => result.stdout, enumerable: false })
  return result
}

/** env: { projectDir, guard, run(), shell, onChild(pid, added) } */
export function createShell(env) {
  const shell = pickShell(env.shell)

  async function execute(command, options, run) {
    const started = Date.now()
    const verdict = await env.guard.before('Bash', { command, description: 'step in a lever run' })
    run.note(verdict.notes)
    if (verdict.deny) {
      run.step({ kind: 'sh', label: command, ok: false, detail: 'refused', ms: Date.now() - started })
      run.note([`refused $ ${command.slice(0, 80)}: ${verdict.deny}`])
      return { refused: verdict.deny }
    }
    const finalCommand = typeof verdict.input?.command === 'string' ? verdict.input.command : command
    const cwd = options.cwd ? path.resolve(env.projectDir, expandHome(String(options.cwd))) : env.projectDir
    if (!isFolder(cwd)) {
      // spawn reports a missing folder as "spawn /bin/bash ENOENT", which reads as if the shell were missing
      run.step({ kind: 'sh', label: finalCommand, ok: false, detail: 'no such folder', ms: Date.now() - started })
      return { error: new Error(`$: the folder to run in does not exist: ${options.cwd} (cwd is relative to the project folder)`) }
    }
    const input = options.input === undefined || options.input === null ? null : options.input
    const result = await new Promise(resolve => {
      let child
      try {
        child = spawn(shell.file, shell.args(finalCommand), {
          cwd,
          env: { ...process.env, ...options.env },
          stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        })
      } catch (error) {
        resolve(makeResult(finalCommand, { stderr: String(error.message), ms: Date.now() - started }))
        return
      }
      env.onChild?.(child.pid, true)
      if (input !== null) {
        child.stdin.on('error', () => {}) // the command may stop reading before the text ends
        child.stdin.end(typeof input === 'string' || ArrayBuffer.isView(input) ? input : String(input))
      }
      const out = []
      const err = []
      let outBytes = 0
      let errBytes = 0
      child.stdout.on('data', chunk => {
        outBytes += chunk.length
        if (outBytes <= OUTPUT_CAP) out.push(chunk)
      })
      child.stderr.on('data', chunk => {
        errBytes += chunk.length
        if (errBytes <= OUTPUT_CAP) err.push(chunk)
      })
      const stop = () => {
        killTree(child)
        setTimeout(() => killTree(child, 'SIGKILL'), 2000).unref()
      }
      let timedOut = false
      const timer = options.timeout
        ? setTimeout(() => {
            timedOut = true
            stop()
          }, options.timeout)
        : null
      run.signal.addEventListener('abort', stop, { once: true })
      let settled = false
      const finish = (exitCode, signal, error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        run.signal.removeEventListener('abort', stop)
        env.onChild?.(child.pid, false)
        let stderr = Buffer.concat(err).toString('utf8')
        if (error) stderr += `${stderr ? '\n' : ''}${error.message}`
        if (timedOut) stderr += `${stderr ? '\n' : ''}stopped after ${options.timeout} ms`
        if (outBytes > OUTPUT_CAP) stderr += `\n(stdout over ${OUTPUT_CAP} bytes was dropped)`
        resolve(
          makeResult(finalCommand, {
            exitCode,
            signal,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr,
            ms: Date.now() - started,
          }),
        )
        run.bytesIn += outBytes + errBytes
      }
      child.on('error', error => finish(null, null, error))
      child.on('close', (code, signal) => finish(code, signal))
    })
    run.step({ kind: 'sh', label: finalCommand, ok: result.ok, quiet: Boolean(options.nothrow), detail: result.signal ?? String(result.exitCode), ms: result.ms })
    const response = { stdout: result.stdout.slice(0, 100_000), stderr: result.stderr.slice(0, 100_000), interrupted: Boolean(result.signal), isImage: false }
    run.note(await env.guard.after('Bash', { command: finalCommand }, response))
    return { result }
  }

  class ShellPromise {
    constructor(command, options) {
      this.command = command
      this.options = { ...options }
      this.run = env.run()
      this.started = null
      const unknown = Object.keys(this.options).filter(key => !OPTIONS.includes(key))
      if (unknown.length) this.run.note([`$ ignored the option${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')} (it takes ${OPTIONS.join(', ')})`])
      queueMicrotask(() => this.start())
    }

    start() {
      this.started ??= execute(this.command, this.options, this.run)
      return this.started
    }

    settled() {
      return this.start().then(outcome => {
        if (outcome.refused) throw new StepRefused(`$ ${this.command}`, outcome.refused)
        if (outcome.error) throw outcome.error
        if (!outcome.result.ok && !this.options.nothrow) throw new ShellError(outcome.result)
        return outcome.result
      })
    }

    then(onFulfilled, onRejected) {
      return this.settled().then(onFulfilled, onRejected)
    }

    catch(onRejected) {
      return this.settled().catch(onRejected)
    }

    finally(onFinally) {
      return this.settled().finally(onFinally)
    }

    nothrow() {
      this.options.nothrow = true
      return this
    }

    /** throws(false) is nothrow(), the name Bun's shell uses. */
    throws(flag = true) {
      this.options.nothrow = !flag
      return this
    }

    timeout(ms) {
      this.options.timeout = ms
      return this
    }

    /** The folder to run in, relative to the project folder. */
    cwd(dir) {
      this.options.cwd = dir
      return this
    }

    /** More environment variables, on top of the server's own. */
    env(vars) {
      this.options.env = { ...this.options.env, ...vars }
      return this
    }

    /** Text or bytes for the command's standard input. */
    input(data) {
      this.options.input = data
      return this
    }

    /** Output never goes anywhere but the result, so this changes nothing; it is here because code written for other
     * shells calls it. */
    quiet() {
      return this
    }

    text() {
      return this.then(result => result.stdout.replace(/\r?\n$/, ''))
    }

    lines() {
      return this.then(result => result.stdout.split(/\r?\n/).filter((line, index, all) => line !== '' || index < all.length - 1))
    }

    json() {
      return this.then(result => JSON.parse(result.stdout))
    }
  }

  const build = (strings, values) => {
    let command = strings[0]
    values.forEach((value, index) => {
      if (value && typeof value === 'object' && value.__leverRaw) command += value.text
      else if (Array.isArray(value)) command += value.map(quote).join(' ')
      else command += quote(value)
      command += strings[index + 1]
    })
    return command
  }

  const make = options => {
    const tag = (first, ...values) => {
      if (Array.isArray(first) && Array.isArray(first.raw)) return new ShellPromise(build(first, values), options)
      if (typeof first === 'string') return new ShellPromise(first, options) // $('ls -la'): a whole command, not quoted
      if (first && typeof first === 'object') return make({ ...options, ...first }) // $({ cwd, timeout, env, nothrow })
      throw new TypeError('Use $`command`, $("command") or $({ cwd, timeout })`command`')
    }
    return tag
  }

  const $ = make({})
  $.raw = text => ({ __leverRaw: true, text: String(text) })
  $.quote = quote
  return $
}
