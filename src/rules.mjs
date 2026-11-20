// Claude Code's deny and ask permission rules, applied to each step inside a run
// (https://code.claude.com/docs/en/permissions). A run cannot stop to ask a person, so an ask rule refuses the step
// as well, with a reason that says to make that call directly.
//   Bash(cmd *)       command text, after splitting compound commands and dropping wrappers and leading assignments
//   Read(path)        gitignore-style paths for read, glob, grep and ls; as a deny rule it also covers writes
//   Edit(path)        paths for write, edit and undo
//   mcp__server[__tool], tool-name globs such as mcp__* or *
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { globToRegExp } from './glob.mjs'

const WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob'])
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '('])
const ENDINGS = new Set(['fi', 'done', 'esac', '}', ')'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** "Tool" or "Tool(specifier)". */
export function parseRule(text) {
  const match = /^([^(]+?)(?:\((.*)\))?$/s.exec(String(text).trim())
  return match ? { tool: match[1].trim(), spec: match[2] === undefined ? null : match[2].trim(), text: String(text).trim() } : null
}

function toolMatches(ruleTool, tool) {
  if (ruleTool === tool) return true
  if (ruleTool.includes('*')) return new RegExp(`^${ruleTool.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(tool)
  // mcp__server covers every tool of that server
  return ruleTool.startsWith('mcp__') && tool.startsWith(`${ruleTool}__`)
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
      if (c === '$' && text[i + 1] === '(') {
        let depth = 0
        let j = i + 1
        for (; j < text.length; j++) {
          if (text[j] === '(') depth++
          else if (text[j] === ')' && --depth === 0) break
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

function bashMatches(spec, command) {
  if (spec === null || spec === '' || spec === '*') return true
  const pattern = spec.endsWith(':*') ? `${spec.slice(0, -2)} *` : spec
  const stars = pattern.split('*').length - 1
  if (stars === 0) return bashPieces(command).some(piece => piece === pattern)
  let source = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  if (stars === 1 && pattern.endsWith(' *')) source = `${source.slice(0, -3)}(?: .*)?` // "ls *" also matches "ls"
  let regex
  try {
    regex = new RegExp(`^${source}$`, 's')
  } catch {
    return false
  }
  return bashPieces(command).some(piece => regex.test(piece))
}

function compilePath(spec, source) {
  let text = spec
  const negate = text.startsWith('!')
  if (negate) text = text.slice(1)
  let anchor
  let relativeForm = false
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
    relativeForm = true
  }
  const trimmed = text.replace(/\/$/, '')
  const relative = relativeForm
  // gitignore: a name without a slash matches at any depth; a deny or ask rule like secrets/** also does
  const anyDepth = !trimmed.includes('/') || (relative && /^[^/*]+\/\*\*$/.test(trimmed))
  const pattern = anyDepth && !trimmed.startsWith('**/') ? `**/${trimmed}` : trimmed
  // folder/** also covers the folder itself, so a search that starts there is stopped too
  const folder = pattern.endsWith('/**') && pattern.length > 3 ? globToRegExp(pattern.slice(0, -3)) : null
  return { negate, anchor, regex: globToRegExp(pattern), folder }
}

function pathMatches(compiled, file) {
  const relative = path.relative(compiled.anchor, file).split(path.sep).join('/')
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  const parts = relative.split('/')
  // the path itself, or a folder above it (a matched folder covers what is inside)
  for (let end = parts.length; end >= 1; end--) {
    const candidate = parts.slice(0, end).join('/')
    if (compiled.regex.test(candidate) || compiled.folder?.test(candidate)) return true
  }
  return false
}

const variants = file => {
  const out = [file]
  try {
    const real = realpathSync(file)
    if (real !== file) out.push(real)
  } catch {
    // a file that does not exist yet
  }
  return out
}

/** sources: [{ file, root, cwd, data }] from the settings files. */
export function createRules(sources) {
  const lists = []
  for (const source of sources) {
    for (const kind of ['deny', 'ask']) {
      const rules = (source.data?.permissions?.[kind] ?? []).map(parseRule).filter(Boolean)
      // MCP rules with parentheses are skipped by Claude Code too
      const usable = rules.filter(rule => !(rule.tool.startsWith('mcp__') && rule.spec !== null))
      for (const rule of usable) {
        if (rule.spec !== null && rule.spec !== '*' && (rule.tool === 'Read' || rule.tool === 'Edit')) rule.path = compilePath(rule.spec, source)
      }
      if (usable.length) lists.push({ kind, file: source.file, rules: usable })
    }
  }

  const hasReadPaths = lists.some(list => list.rules.some(rule => rule.path && rule.tool === 'Read'))

  /** The first rule that stops `file` for the given use ('read' or 'edit'), honouring ! carve-outs within one list. */
  function pathRule(kind, use, file) {
    for (const list of lists) {
      if (list.kind !== kind) continue
      let hit = null
      for (const rule of list.rules) {
        if (!rule.path) continue
        const applies = rule.tool === 'Edit' ? use === 'edit' : use === 'read' || (use === 'edit' && kind === 'deny')
        if (!applies) continue
        const matched = variants(file).some(candidate => pathMatches(rule.path, candidate))
        if (rule.path.negate) {
          if (hit && matched) hit = null
        } else if (matched && !hit) hit = rule
      }
      if (hit) return { rule: hit, file: list.file }
    }
    return null
  }

  function find(kind, tool, input) {
    for (const list of lists) {
      if (list.kind !== kind) continue
      for (const rule of list.rules) {
        if (rule.path) continue
        const bare = rule.spec === null || rule.spec === '*'
        if (tool === 'Bash' && toolMatches(rule.tool, 'Bash') && rule.tool !== '*' && !bare) {
          if (!/^[A-Za-z_]+\s*:/.test(rule.spec) || /:\*$/.test(rule.spec)) {
            if (bashMatches(rule.spec, String(input?.command ?? ''))) return { rule, file: list.file }
          }
          continue
        }
        const family = (rule.tool === 'Edit' && EDIT_TOOLS.has(tool)) || (rule.tool === 'Read' && READ_TOOLS.has(tool))
        if (bare && (family || toolMatches(rule.tool, tool))) return { rule, file: list.file }
      }
    }
    const use = READ_TOOLS.has(tool) ? 'read' : EDIT_TOOLS.has(tool) ? 'edit' : null
    const target = input?.file_path ?? input?.path
    if (use && typeof target === 'string') return pathRule(kind, use, target)
    return null
  }

  return {
    size: lists.reduce((sum, list) => sum + list.rules.length, 0),
    /** { deny } when a deny or ask rule stops this step, else null. */
    check(tool, input) {
      const denied = find('deny', tool, input)
      if (denied) return { deny: `the permission rule ${denied.rule.text} in ${denied.file} refuses this step` }
      const asked = find('ask', tool, input)
      if (asked) return { deny: `the permission rule ${asked.rule.text} in ${asked.file} wants a person to approve this step; make it as a normal tool call instead` }
      return null
    },
    /** True when reading this file is refused, so search results and listings can leave it out. */
    hidden(file) {
      if (!hasReadPaths) return false
      return Boolean(pathRule('deny', 'read', file) ?? pathRule('ask', 'read', file))
    },
  }
}
