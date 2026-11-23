// The thread that runs the code. The server talks to it with messages, so nothing the code prints can reach the
// server's stdout (the MCP channel), and a run that never gives control back can be ended by ending this thread.
import { parentPort, workerData } from 'node:worker_threads'
import { createMcp } from './helpers/mcp.mjs'
import { createSession } from './session.mjs'

// Node's experimental-feature warnings would otherwise land in the client's log on every start.
process.removeAllListeners('warning')

const { config } = workerData
const session = createSession(config, {
  onChild: (pid, added) => parentPort.postMessage({ type: 'child', pid, added }),
  onStep: (id, step) => parentPort.postMessage({ type: 'step', id, label: `${step.kind} ${step.label}`.slice(0, 120) }),
  mcp: env => createMcp(env, config),
})

// Code can leave work behind that fails later: a timer that throws, a promise nobody awaits. That must not end this
// thread, which would silently lose state, jobs and the undo history; the next reply reports it instead.
process.on('uncaughtException', error => session.stray(error))
process.on('unhandledRejection', reason => session.stray(reason))

parentPort.on('message', message => {
  if (message.type === 'run') {
    session.run(message.id, message.code, { timeoutMs: message.timeoutMs, softLimitMs: message.softLimitMs }).then(reply => parentPort.postMessage({ type: 'done', id: message.id, reply }))
  } else if (message.type === 'stop') session.stop(message.id, message.reason)
  else if (message.type === 'detach') session.detach(message.id)
  else if (message.type === 'close') session.close().finally(() => process.exit(0))
})
