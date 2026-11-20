// $`cmd ${value}`: runs a shell command as a step. Interpolated values are quoted; arrays become several arguments.
// The promise starts on the next microtask, so `.nothrow()` or `.timeout(ms)` chained right away still apply.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const OUTPUT_CAP = 16 * 1024 * 1024
const SAFE = /^[\w@%+=:,./-]+$/

export function quote(value) {
  if (value === null || value === undefined) return "''"
  const text = String(value)
  if (text !== '' && SAFE.test(text)) return text
  if (process.platform === 'win32') return `"${text.replace(/"/g, '""')}"`
  return `'${text.replace(/'/g, "'\\''")}'`
}

export class ShellError extends Error {
  constructor(result) {
    const status = result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`
    const tail = (result.stderr || result.stdout || '').trim().slice(-1500)
    super(`Command failed (${status}): ${result.command}${tail ? `\n${tail}` : ''}`)
    this.name = 'ShellError'
    this.result = result
  }
}

export class StepRefused extends Error {
  constructor(step, reason) {
    super(`Refused ${step}: ${reason}`)
    this.name = 'StepRefused'
  }
}

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
    const cwd = options.cwd ? path.resolve(env.projectDir, options.cwd) : env.projectDir
    const result = await new Promise(resolve => {
      let child
      try {
        child = spawn(shell.file, shell.args(finalCommand), {
          cwd,
          env: { ...process.env, ...options.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        })
      } catch (error) {
        resolve(makeResult(finalCommand, { stderr: String(error.message), ms: Date.now() - started }))
        return
      }
      env.onChild?.(child.pid, true)
      run.children.add(child)
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
      let timedOut = false
      const timer = options.timeout
        ? setTimeout(() => {
            timedOut = true
            killTree(child)
            setTimeout(() => killTree(child, 'SIGKILL'), 2000).unref()
          }, options.timeout)
        : null
      const stop = () => {
        killTree(child)
        setTimeout(() => killTree(child, 'SIGKILL'), 2000).unref()
      }
      run.signal.addEventListener('abort', stop, { once: true })
      let settled = false
      const finish = (exitCode, signal, error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        run.signal.removeEventListener('abort', stop)
        run.children.delete(child)
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
      queueMicrotask(() => this.start())
    }

    start() {
      this.started ??= execute(this.command, this.options, this.run)
      return this.started
    }

    settled() {
      return this.start().then(outcome => {
        if (outcome.refused) throw new StepRefused(`$ ${this.command}`, outcome.refused)
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

    timeout(ms) {
      this.options.timeout = ms
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
