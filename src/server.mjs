// The MCP server: newline-delimited JSON-RPC on stdin and stdout, one tool named run. It answers both the 2026-07-28
// handshake (server/discover, the version in each request's _meta) and the older initialize handshake.
import readline from 'node:readline'
import { NAME, VERSION } from './config.mjs'
import { INSTRUCTIONS, TOOL_DESCRIPTION } from './docs.mjs'
import { createRunner } from './runner.mjs'

export const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const INITIALIZE_LATEST = '2025-11-25' // the newest version that still uses initialize
const META = 'io.modelcontextprotocol/'
const CACHE = { ttlMs: 3_600_000, cacheScope: 'public' }
const HEARTBEAT = 15_000

export const RUN_TOOL = {
  name: 'run',
  title: 'Run JavaScript',
  description: TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript to run. await works at the top level; the last expression or a top-level return is the result.' },
      background: { type: 'boolean', description: 'Start it as a job and reply at once; get the reply later with jobs.wait(id).' },
      timeout: { type: 'number', description: 'Seconds before the run is stopped (default 600; background 7200).' },
    },
    required: ['code'],
    additionalProperties: false,
  },
  annotations: { title: 'Run JavaScript', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // Claude Code defers MCP tools behind tool search by default; run is the tool for most steps, so it loads up front and
  // the first use costs no extra search turn (https://code.claude.com/docs/en/mcp#mark-a-tool-to-load-upfront-or-stay-deferred).
  _meta: { 'anthropic/alwaysLoad': true },
}

/** Claude Code moves long tool calls to the background by itself; other clients (Codex: 60 s) need lever to. */
export function autoBackgroundFor(clientName, configured) {
  if (configured !== null && configured !== undefined) return configured
  return /claude/i.test(clientName ?? '') ? 0 : 50_000
}

export function startServer(config, { input = process.stdin, output = process.stdout, onClose } = {}) {
  const runner = createRunner(config)
  const serverInfo = { name: NAME, title: 'lever', version: VERSION }
  const active = new Map()
  let clientName = ''

  const send = message => output.write(`${JSON.stringify(message)}\n`)
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result: { ...result, _meta: { ...result._meta, [`${META}serverInfo`]: serverInfo } } })
  const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })

  async function callTool(id, params) {
    if (params?.name !== 'run') return fail(id, -32602, `Unknown tool: ${params?.name}`)
    const args = params.arguments ?? {}
    if (typeof args.code !== 'string' || args.code.trim() === '') {
      return reply(id, { content: [{ type: 'text', text: 'run needs code: a string of JavaScript.' }], isError: true })
    }
    const controller = new AbortController()
    active.set(id, controller)
    const token = params._meta?.progressToken
    let tick = 0
    let lastSent = 0
    const progress = message => {
      if (token === undefined || controller.signal.aborted) return
      lastSent = Date.now()
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++tick, message } })
    }
    const started = Date.now()
    const heartbeat = token === undefined ? null : setInterval(() => {
      if (Date.now() - lastSent >= HEARTBEAT) progress(`running for ${Math.round((Date.now() - started) / 1000)} s`)
    }, HEARTBEAT)
    try {
      const seconds = Number(args.timeout)
      const result = await runner.run(args.code, {
        background: args.background === true,
        timeoutMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, config.backgroundTimeoutMs) : undefined,
        autoBackgroundMs: autoBackgroundFor(clientName, config.autoBackgroundMs),
        signal: controller.signal,
        onStep: label => {
          if (Date.now() - lastSent >= 3000) progress(label)
        },
      })
      // A cancelled request gets no response (MCP cancellation rules).
      if (!controller.signal.aborted) reply(id, { content: [{ type: 'text', text: result.text }], isError: result.isError })
    } finally {
      clearInterval(heartbeat)
      active.delete(id)
    }
  }

  function handle(message) {
    if (Array.isArray(message)) return message.forEach(handle)
    if (!message || typeof message !== 'object') return fail(null, -32600, 'Invalid request')
    const { id, method, params } = message
    const isRequest = id !== undefined && id !== null
    const meta = params?._meta ?? {}
    if (meta[`${META}clientInfo`]?.name) clientName = meta[`${META}clientInfo`].name
    const asked = meta[`${META}protocolVersion`]
    if (isRequest && asked && !PROTOCOL_VERSIONS.includes(asked)) {
      return fail(id, -32022, `Unsupported protocol version ${asked}`, { supported: PROTOCOL_VERSIONS, requested: asked })
    }
    switch (method) {
      case 'initialize': {
        clientName = params?.clientInfo?.name ?? clientName
        const version = PROTOCOL_VERSIONS.includes(params?.protocolVersion) && params.protocolVersion !== PROTOCOL_VERSIONS[0] ? params.protocolVersion : INITIALIZE_LATEST
        return reply(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo, instructions: INSTRUCTIONS })
      }
      case 'server/discover':
        return reply(id, { supportedVersions: PROTOCOL_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, ...CACHE })
      case 'ping':
        return reply(id, {})
      case 'tools/list':
        return reply(id, { tools: [RUN_TOOL], ...CACHE })
      case 'tools/call':
        return callTool(id, params).catch(error => fail(id, -32603, `lever: ${error.message}`))
      case 'notifications/cancelled':
        return active.get(params?.requestId)?.abort()
      default:
        if (isRequest) return fail(id, -32601, `Method not found: ${method}`)
    }
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  lines.on('line', line => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return fail(null, -32700, 'Parse error')
    }
    handle(message)
  })
  lines.on('close', async () => {
    await runner.close()
    onClose?.()
  })
  return { runner, close: () => lines.close() }
}
