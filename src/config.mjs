// Settings come from environment variables first, then ~/.config/lever/config.json (or LEVER_CONFIG), then defaults.
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const NAME = 'lever'
export const VERSION = '0.1.0'

const DEFAULTS = {
  maxOutput: 8000, // characters of text one run may return before the rest goes to a file
  timeoutMs: 600_000, // a foreground run stops after ten minutes
  backgroundTimeoutMs: 7_200_000, // a background job stops after two hours
  autoBackgroundMs: null, // null: decided per client (Codex has a 60 s tool limit, Claude Code backgrounds by itself)
  hooks: 'auto', // run Claude Code's PreToolUse/PostToolUse hooks for every step inside the code
  guards: [], // modules that may refuse a step: export default (step) => reason | { deny } | { note } | null
  shell: null, // null: bash when present, else sh
  spillDir: null, // where cut output is saved; null: <tmp>/lever-<uid>
  mcpImport: ['claude', 'project'], // which MCP server lists to offer as mcp.<server>.<tool>()
  mcpServers: {}, // extra servers in the same shape as .mcp.json
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function envNumber(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function envList(name) {
  const raw = process.env[name]
  if (!raw) return undefined
  return raw.split(path.delimiter).map(s => s.trim()).filter(Boolean)
}

export function configPath() {
  return process.env.LEVER_CONFIG || path.join(os.homedir(), '.config', NAME, 'config.json')
}

export function loadConfig(overrides = {}) {
  const file = readJson(configPath()) ?? {}
  const pick = (key, envValue) => overrides[key] ?? envValue ?? file[key] ?? DEFAULTS[key]
  // An empty CLAUDE_PROJECT_DIR counts as unset.
  const projectDir = path.resolve(overrides.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd())
  const config = {
    projectDir,
    maxOutput: pick('maxOutput', envNumber('LEVER_MAX_OUTPUT')),
    timeoutMs: pick('timeoutMs', envNumber('LEVER_TIMEOUT_MS')),
    backgroundTimeoutMs: pick('backgroundTimeoutMs', envNumber('LEVER_BACKGROUND_TIMEOUT_MS')),
    autoBackgroundMs: pick('autoBackgroundMs', envNumber('LEVER_AUTO_BACKGROUND_MS')),
    hooks: pick('hooks', process.env.LEVER_HOOKS),
    guards: [...(file.guards ?? []), ...(envList('LEVER_GUARDS') ?? []), ...(overrides.guards ?? [])],
    shell: pick('shell', process.env.LEVER_SHELL),
    spillDir: pick('spillDir', process.env.LEVER_SPILL_DIR) ?? path.join(os.tmpdir(), `${NAME}-${os.userInfo().uid}`),
    mcpImport: pick('mcpImport', envList('LEVER_MCP_IMPORT')),
    mcpServers: { ...(file.mcpServers ?? {}), ...(overrides.mcpServers ?? {}) },
  }
  if (config.hooks === 'auto') {
    // Claude Code passes CLAUDE_PROJECT_DIR to the servers it starts; other clients have no Claude Code hooks to honour.
    config.hooks = process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDECODE ? 'on' : 'off'
  }
  return config
}
