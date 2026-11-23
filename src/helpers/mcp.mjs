// mcp.<server>.<tool>(args) inside a run: a small client for stdio MCP servers. Servers come from lever's config,
// Claude Code's local and user settings, and the project's .mcp.json (only the servers Claude Code approved there).
// Each server starts on first use and stays up for the session.
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { NAME, readJson, VERSION } from '../config.mjs'
import { saveFile, short } from '../format.mjs'
import { settingsFiles } from '../guard.mjs'
import { checkStep, eachLine, killTree } from './shell.mjs'

const CLIENT = { name: NAME, version: VERSION }
const OLD_PROTOCOL = '2025-11-25'
const NEW_PROTOCOL = '2026-07-28'
const META = 'io.modelcontextprotocol/'
const START_TIMEOUT = 30_000
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' }

class McpError extends Error {
  constructor(message) {
    super(message)
    this.name = 'McpError'
  }
}

/** ${VAR} and ${VAR:-default}, as Claude Code expands them in .mcp.json. */
export function expandVars(value) {
  if (typeof value !== 'string') return value
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name, fallback) =>
    process.env[name] !== undefined ? process.env[name] : fallback !== undefined ? fallback : whole,
  )
}

/** The servers code may call, by name: { command, args, env, type, source } or { skipped: reason }. */
export function serverList(config) {
  const [userSettings, projectSettings, localSettings] = settingsFiles(config.projectDir)
  const stateFile = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json')
  const state = config.mcpImport?.includes('claude') ? readJson(stateFile) ?? {} : {}
  const projectState = state.projects?.[config.projectDir] ?? {}
  const out = {}
  const add = (servers, source, check = () => null) => {
    for (const [name, def] of Object.entries(servers ?? {})) {
      if (out[name] || !def || typeof def !== 'object') continue
      const reason = check(name)
      out[name] = reason ? { skipped: reason, source } : { ...def, source }
    }
  }
  const disabled = new Set(projectState.disabledMcpServers ?? [])
  add(config.mcpServers, 'lever config')
  if (config.mcpImport?.includes('claude')) add(projectState.mcpServers, 'Claude Code (local)', name => (disabled.has(name) ? 'disabled for this project in Claude Code' : null))
  if (config.mcpImport?.includes('project')) {
    // A cloned repository can ship its own .claude/settings.local.json, so that file counts only in a folder the user
    // already trusted in Claude Code.
    const trusted = [userSettings, ...(projectState.hasTrustDialogAccepted === true ? [localSettings] : [])].map(readJson).filter(Boolean)
    const rejected = new Set([...[userSettings, projectSettings, localSettings].map(readJson).filter(Boolean), projectState].flatMap(s => s.disabledMcpjsonServers ?? []))
    const approved = name =>
      [...trusted, projectState].some(s => s.enableAllProjectMcpServers === true || (s.enabledMcpjsonServers ?? []).includes(name))
    add(readJson(path.join(config.projectDir, '.mcp.json'))?.mcpServers, '.mcp.json', name =>
      rejected.has(name) ? 'rejected in Claude Code settings' : approved(name) ? null : 'not approved in Claude Code yet (or add it to lever\'s config)',
    )
  }
  if (config.mcpImport?.includes('claude')) add(state.mcpServers, 'Claude Code (user)', name => (disabled.has(name) ? 'disabled for this project in Claude Code' : null))
  for (const [name, def] of Object.entries(out)) {
    const line = [def.command, ...(def.args ?? [])].join(' ')
    if (name === 'lever' || /\blever(?:\.mjs|-mcp)\b|bin\/lever\b/.test(line)) delete out[name]
    else if (def.type && def.type !== 'stdio') out[name] = { skipped: `only stdio servers can be called from code (this one is ${def.type})`, source: def.source }
  }
  return out
}

function paramsOf(schema) {
  const props = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  return Object.entries(props)
    .map(([key, value]) => `${key}${required.has(key) ? '*' : ''}: ${value?.type ?? (value?.enum ? value.enum.map(v => JSON.stringify(v)).join('|') : 'any')}`)
    .join(', ')
}

const firstSentence = text => {
  const line = short(text ?? '', Infinity)
  const end = line.search(/[.!?](\s|$)/)
  return short(end === -1 ? line : line.slice(0, end + 1), 160)
}

class Client {
  constructor(name, def, env) {
    this.name = name
    this.def = def
    this.env = env
    this.child = null
    this.ready = null
    this.pending = new Map()
    this.seq = 0
    this.stderr = ''
    this.modern = false
    this.toolList = null
  }

  get alive() {
    return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null)
  }

  start() {
    if (this.alive && this.ready) return this.ready
    this.ready = this.launch()
    this.ready.catch(() => {
      this.ready = null
    })
    return this.ready
  }

  async launch() {
    const def = this.def
    if (!def.command) throw new McpError(`mcp.${this.name}: no command in its settings`)
    const envVars = Object.fromEntries(Object.entries(def.env ?? {}).map(([key, value]) => [key, expandVars(String(value))]))
    const child = spawn(expandVars(def.command), (def.args ?? []).map(arg => expandVars(String(arg))), {
      cwd: def.cwd ? expandVars(def.cwd) : this.env.projectDir,
      env: { ...process.env, ...envVars },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.child = child
    this.stderr = ''
    this.env.onChild?.(child.pid, true)
    let rest = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      rest = eachLine(rest, chunk, line => {
        if (line.trim()) this.receive(line)
      })
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk).slice(-4000)
    })
    const gone = (why) => {
      this.env.onChild?.(child.pid, false)
      const tail = this.stderr.trim().split('\n').slice(-5).join('\n')
      for (const { reject } of this.pending.values()) reject(new McpError(`mcp.${this.name} ${why}${tail ? `\n${tail}` : ''}`))
      this.pending.clear()
    }
    child.on('error', error => gone(`could not start: ${error.message}`))
    child.on('exit', (code, signal) => gone(`exited (${signal ?? code})`))
    child.stdin.on('error', () => {})

    try {
      await this.request('initialize', { protocolVersion: OLD_PROTOCOL, capabilities: { roots: { listChanged: false } }, clientInfo: CLIENT }, { timeoutMs: START_TIMEOUT })
      this.notify('notifications/initialized')
    } catch (error) {
      if (error.code !== -32601) throw error
      this.modern = true // a server that only speaks the 2026-07-28 protocol
      await this.request('server/discover', {}, { timeoutMs: START_TIMEOUT })
    }
  }

  receive(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id !== undefined && message.method === undefined) {
      const waiting = this.pending.get(message.id)
      if (!waiting) return
      this.pending.delete(message.id)
      if (message.error) {
        const error = new McpError(`mcp.${this.name}: ${message.error.message ?? 'error'}`)
        error.code = message.error.code
        waiting.reject(error)
      } else waiting.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) {
      // a request from the server
      const answer = result => this.write({ jsonrpc: '2.0', id: message.id, result })
      if (message.method === 'ping') answer({})
      else if (message.method === 'roots/list') answer({ roots: [{ uri: pathToFileURL(this.env.projectDir).href, name: path.basename(this.env.projectDir) }] })
      else this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `lever does not support ${message.method}` } })
    }
  }

  write(message) {
    if (this.alive) this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  withMeta(params) {
    if (!this.modern) return params
    return { ...params, _meta: { ...(params?._meta ?? {}), [`${META}protocolVersion`]: NEW_PROTOCOL, [`${META}clientInfo`]: CLIENT, [`${META}clientCapabilities`]: {} } }
  }

  request(method, params, { timeoutMs, signal } = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      let timer = null
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        this.pending.delete(id)
        done()
        this.notify('notifications/cancelled', { requestId: id, reason: 'the run was stopped' })
        reject(new McpError(`mcp.${this.name}: ${method} cancelled (the run was stopped)`))
      }
      this.pending.set(id, {
        resolve: value => {
          done()
          resolve(value)
        },
        reject: error => {
          done()
          reject(error)
        },
      })
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          done()
          reject(new McpError(`mcp.${this.name}: no answer to ${method} within ${timeoutMs / 1000} s`))
        }, timeoutMs)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.write({ jsonrpc: '2.0', id, method, params: this.withMeta(params) })
    })
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, ...(params || this.modern ? { params: this.withMeta(params ?? {}) } : {}) })
  }

  async tools(signal) {
    await this.start()
    if (this.toolList) return this.toolList
    const all = []
    let cursor
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {}, { signal, timeoutMs: START_TIMEOUT })
      all.push(...(page?.tools ?? []))
      cursor = page?.nextCursor
    } while (cursor)
    this.toolList = all
    return all
  }

  close() {
    if (!this.child) return
    try {
      this.child.stdin.end()
    } catch {
      // already closed
    }
    killTree(this.child)
  }
}

/** env: the session env (projectDir, guard, run(), onChild, spillDir) */
export function createMcp(env, config) {
  const clients = new Map()
  let list = null
  const servers = () => (list ??= serverList(config))

  const client = name => {
    const def = servers()[name]
    if (!def) {
      const known = Object.keys(servers()).filter(key => !servers()[key].skipped)
      throw new McpError(`No MCP server named "${name}". Known: ${known.join(', ') || 'none'} (mcp.servers() lists them)`)
    }
    if (def.skipped) throw new McpError(`MCP server "${name}" is not available: ${def.skipped}`)
    if (!clients.has(name)) clients.set(name, new Client(name, def, env))
    return clients.get(name)
  }

  const saveMedia = (item, label) => saveFile(Buffer.from(item.data, 'base64'), env.spillDir, label, EXT[item.mimeType] ?? 'bin')

  function toValue(result, label) {
    const items = result?.content ?? []
    if (result?.isError) {
      const text = items.filter(item => item.type === 'text').map(item => item.text).join('\n')
      throw new McpError(`${label} failed: ${text || 'the tool reported an error'}`)
    }
    if (result?.structuredContent !== undefined) return result.structuredContent
    const values = items.map(item => {
      if (item.type === 'text') {
        if (/^\s*[[{]/.test(item.text)) {
          try {
            return JSON.parse(item.text)
          } catch {
            // not JSON after all
          }
        }
        return item.text
      }
      if (item.type === 'image' || item.type === 'audio') return { [item.type]: saveMedia(item, label.replace(/\W+/g, '-')), mimeType: item.mimeType }
      if (item.type === 'resource') return item.resource?.text ?? { resource: item.resource?.uri }
      if (item.type === 'resource_link') return { link: item.uri, name: item.name }
      return item
    })
    if (values.length === 1) return values[0]
    return values.every(value => typeof value === 'string') ? values.join('\n') : values
  }

  async function call(server, tool, args = {}) {
    const run = env.run()
    const label = `${server}.${tool}`
    const verdict = await checkStep(env, run, `mcp__${server}__${tool}`, args, label, { kind: 'mcp', name: label })
    const input = verdict.input ?? args
    const started = Date.now()
    let result
    try {
      const target = client(server)
      await target.start()
      result = await target.request('tools/call', { name: tool, arguments: input }, { signal: run.signal })
    } catch (error) {
      run.step({ kind: 'mcp', label, ok: false, detail: error.code ?? 'error', ms: Date.now() - started })
      throw error
    }
    run.bytesIn += Buffer.byteLength(JSON.stringify(result ?? null))
    run.step({ kind: 'mcp', label, ok: !result?.isError, detail: result?.isError ? 'tool error' : 'ok', ms: Date.now() - started })
    run.note(await env.guard.after(`mcp__${server}__${tool}`, input, result))
    return toValue(result, label)
  }

  const api = {
    servers: () =>
      Object.entries(servers()).map(([name, def]) => ({
        name,
        source: def.source,
        ...(def.skipped ? { skipped: def.skipped } : { type: def.type ?? 'stdio', running: clients.get(name)?.alive ?? false }),
      })),
    async tools(name) {
      const run = env.run()
      const found = await client(name).tools(run.signal)
      return found.map(tool => ({ name: tool.name, description: firstSentence(tool.description), params: paramsOf(tool.inputSchema) }))
    },
    call,
    async close() {
      for (const each of clients.values()) each.close()
      clients.clear()
    },
  }

  const skip = prop => typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON' || prop === 'constructor'
  const serverProxy = server =>
    new Proxy(
      {},
      {
        get: (_, tool) => (skip(tool) ? undefined : (args = {}) => call(server, tool, args)),
      },
    )
  return new Proxy(api, {
    get: (target, prop) => (prop in target || skip(prop) ? target[prop] : serverProxy(prop)),
  })
}
