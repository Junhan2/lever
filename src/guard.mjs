// Gives every step inside the code the same checks a normal tool call gets:
//  1. guard modules (in-process, fast): export default (step) => reason | { deny } | { note } | null
//  2. Claude Code's PreToolUse / PostToolUse command hooks from the settings files, run with the documented JSON input
//     and read with the documented exit codes and fields (https://code.claude.com/docs/en/hooks)
// A step is named after the Claude Code tool it stands for: Bash, Read, Write, Edit, Glob, Grep, mcp__server__tool.
import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function settingsFiles(projectDir) {
  const userDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const managed =
    process.platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : process.platform === 'win32'
        ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
        : '/etc/claude-code/managed-settings.json'
  return [
    path.join(userDir, 'settings.json'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
    managed,
  ]
}

/** Matcher rules from the hooks reference: empty or "*" match all; only letters, digits, _, -, spaces, "," and "|"
 * mean exact names; anything else is an unanchored JavaScript regular expression. */
export function matcherMatches(matcher, toolName) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true
  if (/^[\p{L}\p{N}_\-\s,|]+$/u.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map(part => part.trim())
      .filter(Boolean)
      .includes(toolName)
  }
  try {
    return new RegExp(matcher).test(toolName)
  } catch {
    return false
  }
}

export function loadHooks(projectDir) {
  const hooks = { PreToolUse: [], PostToolUse: [] }
  let disabled = false
  for (const file of settingsFiles(projectDir)) {
    let settings
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (settings?.disableAllHooks === true) disabled = true
    for (const event of Object.keys(hooks)) {
      for (const group of settings?.hooks?.[event] ?? []) {
        for (const hook of group?.hooks ?? []) {
          if ((hook.type ?? 'command') !== 'command' || typeof hook.command !== 'string') continue
          hooks[event].push({ matcher: group.matcher, command: hook.command, timeout: hook.timeout, file })
        }
      }
    }
  }
  return disabled ? { PreToolUse: [], PostToolUse: [] } : hooks
}

function runHook(hook, payload, cwd) {
  return new Promise(resolve => {
    const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', hook.command] : ['-c', hook.command]
    let child
    try {
      child = spawn(shell, args, { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, stdio: 'pipe' })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), (Number(hook.timeout) || 600) * 1000)
    child.stdout.on('data', chunk => {
      if (stdout.length < 1_000_000) stdout += chunk
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < 1_000_000) stderr += chunk
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: stderr || String(error) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}

function parseJson(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/** Reads one PreToolUse hook run: exit 2 or permissionDecision "deny" refuses; "ask" also refuses here, because a
 * step inside code cannot stop to ask a person; additionalContext becomes a note for the model. */
export function readPreHook({ code, stdout, stderr }) {
  const json = parseJson(stdout)
  const specific = json?.hookSpecificOutput ?? {}
  const legacy = json?.decision === 'block' ? 'deny' : json?.decision === 'approve' ? 'allow' : undefined
  const decision = code === 2 ? 'deny' : (specific.permissionDecision ?? legacy)
  const reason = specific.permissionDecisionReason ?? json?.reason ?? (code === 2 ? stderr.trim() : '')
  const out = {}
  if (decision === 'deny' || json?.continue === false) out.deny = reason || json?.stopReason || 'a hook refused this step'
  else if (decision === 'ask') out.deny = `a hook wants a person to approve this step${reason ? ` (${reason})` : ''}; run it as a normal tool call instead`
  if (specific.additionalContext) out.note = String(specific.additionalContext)
  if (decision !== 'deny' && specific.updatedInput && typeof specific.updatedInput === 'object') out.input = specific.updatedInput
  return out
}

/** Reads one PostToolUse hook run: exit 2's stderr and decision "block" are feedback for the model, as in Claude Code. */
export function readPostHook({ code, stdout, stderr }) {
  const json = parseJson(stdout)
  const notes = []
  if (code === 2 && stderr.trim()) notes.push(stderr.trim())
  if (json?.decision === 'block' && json.reason) notes.push(String(json.reason))
  if (json?.hookSpecificOutput?.additionalContext) notes.push(String(json.hookSpecificOutput.additionalContext))
  return notes
}

async function loadGuardModules(list, notes) {
  const guards = []
  for (const entry of list) {
    try {
      const url = /^[a-z]+:/i.test(entry) && !/^[a-z]:\\/i.test(entry) ? entry : pathToFileURL(path.resolve(entry)).href
      const mod = await import(url)
      const check = typeof mod.default === 'function' ? mod.default : mod.check
      if (typeof check === 'function') guards.push({ name: path.basename(entry), check })
      else notes.push(`guard ${entry} exports no function and was skipped`)
    } catch (error) {
      notes.push(`guard ${entry} could not load: ${error.message}`)
    }
  }
  return guards
}

export function createGuard({ projectDir, hooks = 'off', guards = [], sessionId = `lever-${process.pid}` }) {
  let modules = null
  const loadNotes = []
  let cached = null
  let checkedAt = 0
  let toolUseCount = 0

  const hookSet = () => {
    if (hooks !== 'on') return { PreToolUse: [], PostToolUse: [] }
    const now = Date.now()
    if (cached && now - checkedAt < 2000) return cached.hooks
    checkedAt = now
    const stamp = settingsFiles(projectDir)
      .map(file => {
        try {
          return statSync(file).mtimeMs
        } catch {
          return 0
        }
      })
      .join(',')
    if (!cached || cached.stamp !== stamp) cached = { stamp, hooks: loadHooks(projectDir) }
    return cached.hooks
  }

  /** Before a step: { deny } refuses it; `notes` go to the model; `input` replaces the step's input when a hook says so. */
  async function before(tool, input) {
    modules ??= await loadGuardModules(guards, loadNotes)
    const notes = loadNotes.splice(0)
    for (const guard of modules) {
      let verdict
      try {
        verdict = await guard.check({ tool, input, cwd: projectDir })
      } catch (error) {
        return { deny: `guard ${guard.name} failed: ${error.message}`, notes }
      }
      if (!verdict) continue
      if (typeof verdict === 'string') return { deny: verdict, notes }
      if (verdict.deny) return { deny: String(verdict.deny), notes }
      if (verdict.note) notes.push(String(verdict.note))
    }
    const matching = hookSet().PreToolUse.filter(hook => matcherMatches(hook.matcher, tool))
    if (matching.length === 0) return { notes, input }
    const payload = {
      session_id: sessionId,
      cwd: projectDir,
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: input,
      tool_use_id: `lever_${++toolUseCount}`,
    }
    const results = await Promise.all(matching.map(hook => runHook(hook, payload, projectDir)))
    let replaced = input
    for (const result of results.map(readPreHook)) {
      if (result.note) notes.push(result.note)
      if (result.deny) return { deny: result.deny, notes }
      if (result.input) replaced = result.input
    }
    return { notes, input: replaced }
  }

  /** After a step that ran: notes from PostToolUse hooks. */
  async function after(tool, input, response) {
    const matching = hookSet().PostToolUse.filter(hook => matcherMatches(hook.matcher, tool))
    if (matching.length === 0) return []
    const payload = {
      session_id: sessionId,
      cwd: projectDir,
      hook_event_name: 'PostToolUse',
      tool_name: tool,
      tool_input: input,
      tool_response: response,
      tool_use_id: `lever_${++toolUseCount}`,
    }
    const results = await Promise.all(matching.map(hook => runHook(hook, payload, projectDir)))
    return results.flatMap(readPostHook)
  }

  return { before, after, describe: () => ({ hooks, guards, settings: settingsFiles(projectDir) }) }
}
