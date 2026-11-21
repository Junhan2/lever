// A guard module for lever. lever calls it before every step inside a run with
//   { tool, input, cwd }
// where tool is the Claude Code tool the step stands for (Bash, Read, Write, Edit, Glob, Grep, mcp__server__tool) and
// input is that tool's input ({ command }, { file_path }, { pattern, path }, or the MCP arguments).
// Return a string (or { deny: reason }) to refuse the step, { note } to pass a message to the model, or null to let it run.
//
// Use it with LEVER_GUARDS=/absolute/path/deny-paths.mjs or "guards": ["/absolute/path/deny-paths.mjs"] in
// ~/.config/lever/config.json. Edit PROTECTED for your machine.
//
// A guard reads what a step says, like Claude Code's own rules do. Code that builds a path at run time or uses Node's
// own modules directly is not stopped by it; see "Safety" in the README.
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()
const PROTECTED = ['.ssh', '.aws', '.gnupg', path.join('.config', 'gh')].map(dir => path.join(HOME, dir))
const SECRET_FILE = /(^|[/\\])\.env(\.[\w.-]+)?$/

/** Every string in the input: a command, a path, MCP arguments. */
const strings = value => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [])

export default function denyPaths({ tool, input }) {
  const text = strings(input).join('\n')
  for (const dir of PROTECTED) {
    const short = `~${dir.slice(HOME.length)}`
    if (text.includes(dir) || text.includes(short)) return `${tool} touches ${short}, which this machine keeps away from agents`
  }
  const file = input?.file_path
  if (typeof file === 'string' && SECRET_FILE.test(file) && !file.endsWith('.example')) return `${tool} on ${path.basename(file)}: .env files hold secrets`
  return null
}
