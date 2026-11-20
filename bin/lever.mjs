#!/usr/bin/env node
// lever: Code Mode for any MCP client.
//   lever                      start the MCP server on stdin and stdout (what clients run)
//   lever run -e CODE | FILE   run code once in this folder and print the reply
//   lever install [--claude] [--codex] [--scope user|project|local] [--force] [--dry-run]
//   lever uninstall [--claude] [--codex] [--scope ...] [--dry-run]
//   lever doctor               check the setup
import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, loadConfig, NAME, VERSION } from '../src/config.mjs'
import { loadHooks, settingsFiles } from '../src/guard.mjs'
import { serverList } from '../src/helpers/mcp.mjs'
import { findRipgrep } from '../src/helpers/search.mjs'
import { createRunner } from '../src/runner.mjs'
import { startServer } from '../src/server.mjs'

const [command = 'serve', ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter(arg => arg.startsWith('--')))
const option = name => {
  const at = rest.indexOf(name)
  return at === -1 ? undefined : rest[at + 1]
}

function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const candidate of process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]) {
      const full = path.join(dir, candidate)
      try {
        if (statSync(full).isFile()) {
          accessSync(full, constants.X_OK)
          return full
        }
      } catch {
        // keep looking
      }
    }
  }
  return null
}

/** The command clients should start: node from PATH (survives Node upgrades better than the resolved binary) and
 * this file's real path. */
function serverCommand() {
  const node = onPath('node') ?? process.execPath
  return [node, realpathSync(fileURLToPath(import.meta.url))]
}

function runCommand(file, args, dryRun) {
  const shown = [file, ...args].map(part => (/[\s'"]/.test(part) ? JSON.stringify(part) : part)).join(' ')
  if (dryRun) {
    console.log(`would run: ${shown}`)
    return { status: 0, stdout: '', stderr: '' }
  }
  const result = spawnSync(file, args, { encoding: 'utf8' })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' }
}

function targets() {
  const wanted = []
  if (flags.has('--claude')) wanted.push('claude')
  if (flags.has('--codex')) wanted.push('codex')
  return wanted.length ? wanted : ['claude', 'codex'].filter(onPath)
}

function install() {
  const dryRun = flags.has('--dry-run')
  const scope = option('--scope') ?? 'user'
  const [node, bin] = serverCommand()
  const list = targets()
  if (list.length === 0) {
    console.log('Neither claude nor codex is on PATH. Add lever to your MCP client by hand:')
    console.log(`  command: ${node}\n  args: ["${bin}"]`)
    return 1
  }
  let failures = 0
  for (const client of list) {
    if (client === 'claude') {
      const exists = runCommand('claude', ['mcp', 'get', NAME], false).status === 0
      if (exists && !flags.has('--force')) {
        console.log(`claude: ${NAME} is already registered (use --force to replace it)`)
        continue
      }
      if (exists) runCommand('claude', ['mcp', 'remove', NAME, '--scope', scope], dryRun)
      const result = runCommand('claude', ['mcp', 'add', '--scope', scope, NAME, '--', node, bin], dryRun)
      console.log(result.status === 0 ? `claude: registered ${NAME} (${scope} scope)` : `claude: failed: ${result.stderr.trim()}`)
      failures += result.status === 0 ? 0 : 1
    } else {
      const exists = /^lever\b/m.test(runCommand('codex', ['mcp', 'list'], false).stdout)
      if (exists && !flags.has('--force')) {
        console.log(`codex: ${NAME} is already registered (use --force to replace it)`)
        continue
      }
      if (exists) runCommand('codex', ['mcp', 'remove', NAME], dryRun)
      const result = runCommand('codex', ['mcp', 'add', NAME, '--', node, bin], dryRun)
      console.log(result.status === 0 ? `codex: registered ${NAME}` : `codex: failed: ${result.stderr.trim()}`)
      failures += result.status === 0 ? 0 : 1
    }
  }
  return failures ? 1 : 0
}

function uninstall() {
  const dryRun = flags.has('--dry-run')
  for (const client of targets()) {
    const args = client === 'claude' ? ['mcp', 'remove', NAME, '--scope', option('--scope') ?? 'user'] : ['mcp', 'remove', NAME]
    const result = runCommand(client, args, dryRun)
    console.log(`${client}: ${result.status === 0 ? 'removed' : `not removed: ${(result.stderr || result.stdout).trim()}`}`)
  }
  return 0
}

async function runOnce() {
  const config = loadConfig({ projectDir: process.cwd() })
  let code
  if (rest[0] === '-e') code = rest[1]
  else if (rest[0] === '-' || rest[0] === undefined) code = readFileSync(0, 'utf8')
  else code = readFileSync(rest[0], 'utf8')
  if (!code?.trim()) {
    console.error('Usage: lever run -e "code" | lever run file.js | echo code | lever run -')
    return 2
  }
  const runner = createRunner(config)
  const reply = await runner.run(code, { autoBackgroundMs: 0 })
  process.stdout.write(`${reply.text}\n`)
  await runner.close()
  return reply.isError ? 1 : 0
}

async function doctor() {
  const config = loadConfig()
  const lines = []
  const ok = (good, text) => lines.push(`${good === true ? 'ok  ' : good === false ? 'FAIL' : 'note'}  ${text}`)
  const [major, minor] = process.versions.node.split('.').map(Number)
  ok(major > 20 || (major === 20 && minor >= 11), `node ${process.version} (needs 20.11 or newer)`)
  const rg = findRipgrep()
  ok(rg ? true : null, rg ? `ripgrep: ${rg}` : 'ripgrep not found: glob and grep use plain Node (slower, no multiline)')
  ok(null, `project folder: ${config.projectDir}`)
  ok(null, `config: ${configPath()}`)
  ok(null, `limits: reply ${config.maxOutput} chars, run ${config.timeoutMs / 1000} s, background ${config.backgroundTimeoutMs / 1000} s`)
  if (config.hooks === 'on') {
    const hooks = loadHooks(config.projectDir)
    const found = settingsFiles(config.projectDir).filter(file => {
      try {
        return statSync(file).isFile()
      } catch {
        return false
      }
    })
    ok(true, `Claude Code hooks: on (${hooks.PreToolUse.length} PreToolUse, ${hooks.PostToolUse.length} PostToolUse from ${found.length} settings files)`)
  } else ok(null, 'Claude Code hooks: off (set LEVER_HOOKS=on to run them outside Claude Code)')
  for (const guard of config.guards) {
    try {
      const loaded = await import(path.isAbsolute(guard) ? `file://${guard}` : guard)
      ok(typeof (loaded.default ?? loaded.check) === 'function', `guard ${guard}`)
    } catch (error) {
      ok(false, `guard ${guard}: ${error.message}`)
    }
  }
  const servers = Object.entries(serverList(config))
  const usable = servers.filter(([, def]) => !def.skipped && (def.type ?? 'stdio') === 'stdio')
  ok(null, `MCP servers callable from code: ${usable.length ? usable.map(([name]) => name).join(', ') : 'none'}`)
  for (const [name, def] of servers.filter(([, d]) => d.skipped)) ok(null, `  ${name} skipped: ${def.skipped}`)
  try {
    mkdirSync(config.spillDir, { recursive: true, mode: 0o700 })
    accessSync(config.spillDir, constants.W_OK)
    ok(true, `long replies saved under ${config.spillDir}`)
  } catch (error) {
    ok(false, `cannot write ${config.spillDir}: ${error.message}`)
  }
  const runner = createRunner(config)
  const started = Date.now()
  const reply = await runner.run("await $`echo ok`.text()", { autoBackgroundMs: 0 })
  await runner.close()
  ok(reply.text.startsWith('ok') && !reply.isError, `self-test run: ${reply.text.split('\n')[0]} in ${Date.now() - started} ms`)
  for (const client of ['claude', 'codex']) {
    if (!onPath(client)) continue
    const registered = client === 'claude' ? runCommand('claude', ['mcp', 'get', NAME], false).status === 0 : /^lever\b/m.test(runCommand('codex', ['mcp', 'list'], false).stdout)
    ok(registered ? true : null, `${client}: ${registered ? 'lever is registered' : 'lever is not registered (lever install)'}`)
  }
  console.log(`${NAME} ${VERSION}\n${lines.join('\n')}`)
  return lines.some(line => line.startsWith('FAIL')) ? 1 : 0
}

const commands = {
  serve: () => {
    startServer(loadConfig(), { onClose: () => process.exit(0) })
    return null
  },
  run: runOnce,
  install,
  uninstall,
  doctor,
  version: () => {
    console.log(VERSION)
    return 0
  },
  help: () => {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 8).map(line => line.replace(/^\/\/ ?/, '')).join('\n'))
    return 0
  },
}

const handler = commands[command] ?? commands[command.replace(/^--?/, '')]
if (!handler) {
  console.error(`Unknown command: ${command}`)
  process.exit(2)
}
const code = await handler()
if (code !== null) process.exit(code)
