// Claude Code's deny and ask permission rules, applied to each step inside a run
// (https://code.claude.com/docs/en/permissions). A run cannot stop to ask a person, so an ask rule refuses the step
// as well, with a reason that says to make that call directly.
//   Bash(cmd *)       command text, after splitting compound commands and dropping wrappers and leading assignments
//   Read(path)        gitignore-style paths for read, glob, grep and ls; as a deny rule it also covers writes
//   Edit(path)        paths for write, edit and undo
//   mcp__server[__tool], tool-name globs such as mcp__* or *
import { lstatSync, readlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { escapeRegExp, globToRegExp } from './glob.mjs'

const WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob'])
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '('])
const ENDINGS = new Set(['fi', 'done', 'esac', '}', ')'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
// macOS and Windows file systems ignore case by default, so .ENV opens .env there
const IGNORE_CASE = process.platform === 'darwin' || process.platform === 'win32'
const fold = text => (IGNORE_CASE ? text.toLowerCase() : text)

/** "Tool" or "Tool(specifier)". */
function parseRule(text) {
  const match = /^([^(]+?)(?:\((.*)\))?$/s.exec(String(text).trim())
  return match ? { tool: match[1].trim(), spec: match[2] === undefined ? null : match[2].trim(), text: String(text).trim() } : null
}

const starSource = text => text.split('*').map(escapeRegExp).join('.*')

/** A rule's tool name as a test on a tool name: exact, a * glob, or mcp__server for every tool of that server. */
function toolTest(ruleTool) {
  if (ruleTool.includes('*')) {
    const regex = new RegExp(`^${starSource(ruleTool)}$`)
    return tool => regex.test(tool)
  }
  return tool => tool === ruleTool || (ruleTool.startsWith('mcp__') && tool.startsWith(`${ruleTool}__`))
}

/** The simple commands inside a shell command line: split at && || ; | |& & and newlines outside quotes, with the
 * insides of $( ) and backticks added, control words removed, and wrappers and leading assignments dropped. */
export function bashPieces(command) {
  const pieces = []
  const visit = text => {
    let current = ''
    let quote = null
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (quote === "'") {
        current += c
        if (c === quote) quote = null
        continue
      }
      if (quote === '"' && c !== '$' && c !== '`') {
        current += c
        if (c === '\\' && i + 1 < text.length) current += text[++i]
        else if (c === quote) quote = null
        continue
      }
      if (c === '\\' && i + 1 < text.length) {
        current += c + text[++i]
        continue
      }
      if (!quote && (c === "'" || c === '"')) {
        quote = c
        current += c
        continue
      }
      if (c === '`') {
        const end = text.indexOf('`', i + 1)
        if (end !== -1) {
          visit(text.slice(i + 1, end))
          current += text.slice(i, end + 1)
          i = end
          continue
        }
      }
      if ((c === '$' || ((c === '<' || c === '>') && !quote)) && text[i + 1] === '(') {
        let depth = 0
        let inner = null
        let j = i + 1
        for (; j < text.length; j++) {
          const d = text[j]
          if (inner) {
            if (d === '\\' && inner === '"') j++
            else if (d === inner) inner = null
          } else if (d === '\\') j++
          else if (d === "'" || d === '"') inner = d
          else if (d === '(') depth++
          else if (d === ')' && --depth === 0) break
        }
        visit(text.slice(i + 2, j))
        current += text.slice(i, j + 1)
        i = j
        continue
      }
      if (quote) {
        current += c // a lone $ inside double quotes
        continue
      }
      const two = text.slice(i, i + 2)
      if (two === '&&' || two === '||' || two === '|&') {
        pieces.push(current)
        current = ''
        i++
      } else if (c === ';' || c === '|' || c === '&' || c === '\n') {
        pieces.push(current)
        current = ''
      } else current += c
    }
    pieces.push(current)
  }
  visit(command)
  return pieces.map(simplify).filter(Boolean)
}

function simplify(piece) {
  let words = piece.trim()
  for (;;) {
    const before = words
    words = words.replace(/^[({]\s*/, '').replace(/\s*[)}]$/, '').trim()
    const first = words.split(/\s+/)[0]
    if (KEYWORDS.has(first)) words = words.slice(first.length).trim()
    else if (ENDINGS.has(first) && words === first) return ''
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) words = words.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:\\.|[^"])*"|\S*)\s*/, '')
    else if (WRAPPERS.has(first) && !(first === 'command' && /^command\s+-[vV]\b/.test(words))) {
      words = words.slice(first.length).trim()
      // the wrapper's own options, and timeout's duration
      while (/^-\S*/.test(words)) words = words.replace(/^-(?:[sk]\s+\S+|n\s+-?\d+|\S*)\s*/, '')
      if (first === 'timeout') words = words.replace(/^\d+(?:\.\d+)?[smhd]?\s*/, '')
    } else if (first === 'xargs' && !/^xargs\s+-/.test(words)) words = words.slice(5).trim()
    if (words === before) return words
  }
}

/** A Bash rule's specifier as a test on the simple commands of one command line (from bashPieces). */
function bashTest(spec) {
  if (spec === '') return () => true
  // "tool:arg" without a trailing :* is not a command pattern
  if (/^[A-Za-z_]+\s*:/.test(spec) && !/:\*$/.test(spec)) return () => false
  const pattern = spec.endsWith(':*') ? `${spec.slice(0, -2)} *` : spec
  const stars = pattern.split('*').length - 1
  if (stars === 0) return pieces => pieces.includes(pattern)
  let source = starSource(pattern)
  if (stars === 1 && pattern.endsWith(' *')) source = `${source.slice(0, -3)}(?: .*)?` // "ls *" also matches "ls"
  try {
    const regex = new RegExp(`^${source}$`, 's')
    return pieces => pieces.some(piece => regex.test(piece))
  } catch {
    return () => false
  }
}

function compilePath(spec, source) {
  let text = spec
  const negate = text.startsWith('!')
  if (negate) text = text.slice(1)
  let anchor
  let relative = false
  if (!negate && text.startsWith('//')) {
    anchor = '/'
    text = text.slice(2)
  } else if (!negate && text.startsWith('~/')) {
    anchor = os.homedir()
    text = text.slice(2)
  } else if (!negate && text.startsWith('/')) {
    anchor = source.root
    text = text.slice(1)
  } else {
    anchor = source.cwd
    text = text.replace(/^\.\//, '')
    relative = true
  }
  const trimmed = text.replace(/\/$/, '')
  // gitignore: a name without a slash matches at any depth; a deny or ask rule like secrets/** also does
  const anyDepth = !trimmed.includes('/') || (relative && /^[^/*]+\/\*\*$/.test(trimmed))
  const pattern = anyDepth && !trimmed.startsWith('**/') ? `**/${trimmed}` : trimmed
  // folder/** also covers the folder itself, so a search that starts there is stopped too
  const options = { ignoreCase: IGNORE_CASE }
  const folder = pattern.endsWith('/**') && pattern.length > 3 ? globToRegExp(pattern.slice(0, -3), options) : null
  return { negate, anchor: fold(anchor), regex: globToRegExp(pattern, options), folder }
}

function pathMatches(compiled, file) {
  const relative = path.relative(compiled.anchor, fold(file)).split(path.sep).join('/')
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  const parts = relative.split('/')
  // the path itself, or a folder above it (a matched folder covers what is inside)
  for (let end = parts.length; end >= 1; end--) {
    const candidate = parts.slice(0, end).join('/')
    if (compiled.regex.test(candidate) || compiled.folder?.test(candidate)) return true
  }
  return false
}

/** Where `file` really is: each folder and link followed in order from the root, as the system does, with a missing
 * end left as written (a write creates it). null when the links go round or run too deep, which counts as refused. */
export function resolvePath(file) {
  const absolute = path.resolve(file)
  let queue = absolute.split(path.sep).filter(Boolean)
  let current = path.parse(absolute).root
  let links = 0
  while (queue.length) {
    const part = queue.shift()
    if (part === '.') continue
    if (part === '..') {
      current = path.dirname(current)
      continue
    }
    const next = path.join(current, part)
    let info
    try {
      info = lstatSync(next)
    } catch {
      return path.join(next, ...queue)
    }
    if (info.isSymbolicLink()) {
      if (++links > 40) return null
      let target
      try {
        target = readlinkSync(next)
      } catch {
        return null
      }
      if (path.isAbsolute(target)) current = path.parse(target).root
      queue = [...target.split(path.sep).filter(Boolean), ...queue]
      continue
    }
    current = next
  }
  return current
}

/** sources: [{ file, root, cwd, data }] from the settings files. Each rule is compiled once, here. */
export function createRules(sources) {
  const lists = []
  for (const source of sources) {
    for (const kind of ['deny', 'ask']) {
      const rules = (source.data?.permissions?.[kind] ?? []).map(parseRule).filter(Boolean)
      // MCP rules with parentheses are skipped by Claude Code too
      const usable = rules.filter(rule => !(rule.tool.startsWith('mcp__') && rule.spec !== null))
      for (const rule of usable) {
        const bare = rule.spec === null || rule.spec === '*'
        rule.matchesTool = toolTest(rule.tool)
        if (!bare && (rule.tool === 'Read' || rule.tool === 'Edit')) rule.path = compilePath(rule.spec, source)
        else if (!bare && rule.tool !== '*' && rule.matchesTool('Bash')) rule.bash = bashTest(rule.spec)
      }
      if (usable.length) lists.push({ kind, file: source.file, rules: usable })
    }
  }

  const some = test => lists.some(list => list.rules.some(test))
  const hasBashRules = some(rule => rule.bash)
  const hasPathRules = some(rule => rule.path)
  const hasReadPaths = some(rule => rule.path && rule.tool === 'Read')

  /** The first rule that stops a file for the given use ('read' or 'edit'), honouring ! carve-outs within one list.
   * `candidates` are the path as written and where it really leads; null when it cannot be resolved, which any rule
   * that could apply refuses. */
  function pathRule(kind, use, candidates) {
    for (const list of lists) {
      if (list.kind !== kind) continue
      let hit = null
      for (const rule of list.rules) {
        // Read rules cover edits too: an edit's errors tell what the file holds
        if (!rule.path || (rule.tool === 'Edit' && use !== 'edit')) continue
        const matched = candidates === null ? !rule.path.negate : candidates.some(candidate => pathMatches(rule.path, candidate))
        if (rule.path.negate) {
          if (hit && matched) hit = null
        } else if (matched && !hit) hit = rule
      }
      if (hit) return { rule: hit, file: list.file }
    }
    return null
  }

  function find(kind, tool, step) {
    for (const list of lists) {
      if (list.kind !== kind) continue
      for (const rule of list.rules) {
        if (rule.path) continue
        if (rule.bash) {
          if (tool === 'Bash' && rule.bash(step.pieces)) return { rule, file: list.file }
          continue
        }
        const bare = rule.spec === null || rule.spec === '*'
        const family = (rule.tool === 'Edit' && EDIT_TOOLS.has(tool)) || (rule.tool === 'Read' && READ_TOOLS.has(tool))
        if (bare && (family || rule.matchesTool(tool))) return { rule, file: list.file }
      }
    }
    return step.path ? pathRule(kind, step.path.use, step.path.candidates) : null
  }

  return {
    /** { deny } when a deny or ask rule stops this step, else null. */
    check(tool, input) {
      // What the rules compare, worked out once for the step: the simple commands, and the path as written and where
      // it really leads.
      const step = { pieces: tool === 'Bash' && hasBashRules ? bashPieces(String(input?.command ?? '')) : [] }
      const use = READ_TOOLS.has(tool) ? 'read' : EDIT_TOOLS.has(tool) ? 'edit' : null
      const target = input?.file_path ?? input?.path
      if (use && typeof target === 'string' && hasPathRules) {
        const real = resolvePath(target)
        step.path = { use, candidates: real === null ? null : real === target ? [target] : [target, real] }
      }
      const denied = find('deny', tool, step)
      if (denied) return { deny: `the permission rule ${denied.rule.text} in ${denied.file} refuses this step` }
      const asked = find('ask', tool, step)
      if (asked) return { deny: `the permission rule ${asked.rule.text} in ${asked.file} wants a person to approve this step; make it as a normal tool call instead` }
      return null
    },
    /** True when reading this file is refused, so search results and listings can leave it out. Compared as written,
     * without following links, for speed. */
    hidden(file) {
      if (!hasReadPaths) return false
      return Boolean(pathRule('deny', 'read', [file]) ?? pathRule('ask', 'read', [file]))
    },
  }
}
