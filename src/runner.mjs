// Starts the worker thread, hands it runs, and keeps the promises made to the client: one reply per run, a stop at
// the time limit, and an early "continues in the background" reply for clients that cannot wait long.
import { Worker } from 'node:worker_threads'
import { seconds } from './format.mjs'

const GRACE = 3000 // how long a stopped run gets to answer before its thread is replaced

export function createRunner(config) {
  let worker = null
  let seq = 0
  const pending = new Map()
  const pids = new Set()

  function start() {
    const current = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { config }, stdout: true, stderr: true })
    // Code cannot write to the MCP channel: whatever reaches the thread's stdout goes to the server's stderr log.
    current.stdout.on('data', chunk => process.stderr.write(chunk))
    current.stderr.on('data', chunk => process.stderr.write(chunk))
    current.on('message', receive)
    current.on('error', error => lost(current, `the worker failed: ${error.message}`))
    current.on('exit', code => lost(current, `the worker stopped (exit ${code})`))
    worker = current
  }

  function receive(message) {
    if (message.type === 'child') {
      if (message.added) pids.add(message.pid)
      else pids.delete(message.pid)
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.type === 'step') entry.onStep?.(message.label)
    else if (message.type === 'done') finish(message.id, message.reply)
  }

  function finish(id, reply) {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    entry.timers.forEach(clearTimeout)
    if (!entry.answered) entry.resolve(reply)
  }

  function answerEarly(id, text) {
    const entry = pending.get(id)
    if (!entry || entry.answered) return
    entry.answered = true
    entry.worker.postMessage({ type: 'detach', id })
    entry.resolve({ text, isError: false, file: null })
    if (!entry.fixedLimit) {
      // a run that continues in the background gets the background time limit
      clearTimeout(entry.limitTimer)
      const left = Math.max(0, config.backgroundTimeoutMs - (Date.now() - entry.startedAt))
      entry.limitTimer = setTimeout(() => stop(id, `stopped after ${seconds(config.backgroundTimeoutMs)}`), left)
      entry.timers.push(entry.limitTimer)
    }
  }

  function stop(id, reason) {
    const entry = pending.get(id)
    if (!entry) return
    entry.worker.postMessage({ type: 'stop', id, reason })
    entry.timers.push(
      setTimeout(() => {
        if (!pending.has(id)) return
        const target = entry.worker
        lost(target, `${reason}; the code did not give control back, so its thread was replaced (state, jobs and undo history were reset)`)
        target.terminate()
      }, GRACE),
    )
  }

  function killChildren() {
    for (const pid of pids) {
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    pids.clear()
  }

  function lost(target, message) {
    if (worker !== target) return
    worker = null
    killChildren()
    for (const [id, entry] of pending) {
      if (entry.worker !== target) continue
      pending.delete(id)
      entry.timers.forEach(clearTimeout)
      if (!entry.answered) entry.resolve({ text: `Stopped: ${message}`, isError: true, file: null })
    }
  }

  /** options: { timeoutMs, background, autoBackgroundMs, signal, onStep(label) } → Promise<{ text, isError, file }> */
  function run(code, options = {}) {
    if (!worker) start()
    const id = String(++seq)
    const background = Boolean(options.background)
    const limit = options.timeoutMs ?? (background ? config.backgroundTimeoutMs : config.timeoutMs)
    const softLimitMs = !background && options.autoBackgroundMs > 0 ? options.autoBackgroundMs : null
    worker.postMessage({ type: 'run', id, code, timeoutMs: limit, softLimitMs })
    return new Promise(resolve => {
      const entry = { resolve, worker, startedAt: Date.now(), timers: [], answered: false, fixedLimit: options.timeoutMs !== undefined, onStep: options.onStep }
      pending.set(id, entry)
      entry.limitTimer = setTimeout(() => stop(id, `stopped after ${seconds(limit)}`), limit)
      entry.timers.push(entry.limitTimer)
      if (background) {
        answerEarly(id, `Started job ${id} in the background. Get its reply with: return await jobs.wait(${id})`)
      } else if (softLimitMs) {
        entry.timers.push(
          setTimeout(
            () => answerEarly(id, `Still running after ${seconds(softLimitMs)}, so it goes on in the background as job ${id}. Get its reply with: return await jobs.wait(${id})`),
            softLimitMs,
          ),
        )
      }
      options.signal?.addEventListener('abort', () => stop(id, 'cancelled by the client'), { once: true })
    })
  }

  async function close() {
    const target = worker
    if (!target) return
    target.postMessage({ type: 'close' })
    await Promise.race([new Promise(resolve => target.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000).unref())])
    if (worker === target) {
      lost(target, 'the server closed')
      await target.terminate()
    }
    killChildren()
  }

  return { run, close }
}
