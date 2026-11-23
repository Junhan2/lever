// Runs model-written code as the body of a fresh async function in one long-lived vm context:
//  - top-level await works, and so does a top-level `return`
//  - the last expression statement is the result (found by a small scanner, then confirmed by compiling)
//  - each run has its own scope, so reusing a name such as `files` never clashes with an earlier run;
//    values meant for later runs go on `state` (or globalThis), which lives as long as the session
import path from 'node:path'
import vm from 'node:vm'

const STATEMENT_START =
  /^(?:if|for|while|do|switch|try|throw|return|break|continue|const|let|var|function|class|import|export|debugger|with|async\s+function)\b/
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
])
const CONTINUE_WORDS = new Set(['in', 'of', 'instanceof', 'else', 'catch', 'finally'])
const OPEN_WORDS = new Set([...REGEX_AFTER_WORD, 'extends'])
const PUNCT = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
]
const ENDS_EXPRESSION = new Set([')', ']', '}', '++', '--'])
const NEW_STATEMENT_PUNCT = new Set(['!', '~', '++', '--', '{', ';'])
const BLOCK_HEADS = new Set(['if', 'for', 'while', 'switch', 'try', 'do', 'function', 'class']) // statements that end with a block
const BLOCK_OPENERS = new Set(['else', 'try', 'finally', 'do', 'catch']) // words a block can follow directly
const BLOCK_CONTINUES = new Set(['else', 'catch', 'finally'])

/** Finds the range of the last top-level statement: { start, end } in `code`, or null when there is none.
 * Strings, template literals (with nested `${}`), comments and regular expressions are skipped. A line break ends a
 * statement only where JavaScript's automatic semicolon insertion would end it, and the block of an if, for, while,
 * try, function or class ends its statement, so `for (…) {…}` followed by `({ … })` is two statements. */
export function lastStatement(code) {
  const n = code.length
  let i = 0
  let depth = 0
  const templates = [] // depth at which each open `${` began
  let prev = null // last significant token: { kind, value }
  let newline = false // a line break since `prev`
  let current = -1 // start of the statement in progress at depth 0
  let last = null
  let lastEnd = -1 // end of the last significant token at depth 0
  let head = '' // the first word of that statement ('' when it starts with something else)
  let size = 0 // its tokens at depth 0 so far
  let brace = null // what the open top-level { is: 'block' (a statement's body), 'arrow' (an arrow function's) or 'value'
  let closed = null // the same for a top-level } when it is the last token

  const endsStatement = token =>
    token.kind === 'word' ? !OPEN_WORDS.has(token.value) : token.kind === 'punct' ? ENDS_EXPRESSION.has(token.value) : true
  const continuesStatement = (kind, value) =>
    kind === 'template' || (kind === 'word' ? CONTINUE_WORDS.has(value) : kind === 'punct' && !NEW_STATEMENT_PUNCT.has(value))
  const regexAllowed = () =>
    !prev ||
    (prev.kind === 'punct' && (!ENDS_EXPRESSION.has(prev.value) || (prev.value === '}' && depth === 0))) ||
    (prev.kind === 'word' && REGEX_AFTER_WORD.has(prev.value))

  const begin = (start, kind, value) => {
    current = start
    head = kind === 'word' ? value : ''
    size = 0
  }
  /** Whether the statement in progress ended before the token that comes now. */
  const endedBefore = (kind, value) => {
    if (closed === 'block') {
      // the body of a statement ends it, whatever follows, except the words that carry it on
      const carriesOn = kind === 'word' && (BLOCK_CONTINUES.has(value) || (value === 'while' && head === 'do'))
      return !carriesOn && !(kind === 'punct' && value === ';')
    }
    if (!newline || !prev) return false
    // an arrow function cannot be called or indexed, so ( [ or ` on the next line starts a new statement
    if (closed === 'arrow' && (kind === 'template' || (kind === 'punct' && (value === '(' || value === '[')))) return true
    return endsStatement(prev) && !continuesStatement(kind, value)
  }
  /** What a { at depth 0 opens, from the statement it is in and the token before it. */
  const braceKind = () => {
    if (prev?.kind === 'punct' && prev.value === '=>') return 'arrow'
    if (!BLOCK_HEADS.has(head)) return 'value'
    if (head === 'class' || (prev?.kind === 'punct' && prev.value === ')')) return 'block'
    return prev?.kind === 'word' && BLOCK_OPENERS.has(prev.value) ? 'block' : 'value'
  }

  const token = (start, end, kind, value) => {
    if (depth === 0) {
      if (current === -1) begin(start, kind, value)
      else if (endedBefore(kind, value)) {
        last = { start: current, end: lastEnd }
        begin(start, kind, value)
      }
      if (++size === 2 && head === 'async' && kind === 'word' && value === 'function') head = 'function'
      closed = null
      if (kind === 'punct' && value === '{') brace = braceKind()
      else if (kind === 'punct' && value === '}') {
        closed = brace
        brace = null
      }
      lastEnd = end
    }
    prev = { kind, value }
    newline = false
  }

  while (i < n) {
    const c = code[i]
    if (c === '\n') {
      newline = true
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') {
      i++
      continue
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      if (code.slice(i, end).includes('\n')) newline = true
      i = end
      continue
    }
    const start = i
    if (c === '"' || c === "'") {
      i++
      while (i < n && code[i] !== c && code[i] !== '\n') i += code[i] === '\\' ? 2 : 1
      i++
      token(start, i, 'string', null)
      continue
    }
    if (c === '`' || (c === '}' && templates.length && templates[templates.length - 1] === depth)) {
      // A template literal, or the rest of one after a `${ }` closes.
      const resuming = c === '}'
      if (resuming) templates.pop()
      i++
      while (i < n && code[i] !== '`') {
        if (code[i] === '\\') i += 2
        else if (code[i] === '$' && code[i + 1] === '{') break
        else i++
      }
      // the rest of a template after a `${ }` is no token of its own, but the statement reaches to its end
      if (resuming && depth === 0) lastEnd = i + (code[i] === '$' ? 2 : 1)
      if (code[i] === '$') {
        i += 2
        templates.push(depth)
        if (!resuming) token(start, i, 'template', null)
        prev = { kind: 'punct', value: '${' }
        continue
      }
      i++
      if (resuming) prev = { kind: 'template', value: null }
      else token(start, i, 'template', null)
      continue
    }
    if (c === '/' && regexAllowed()) {
      i++
      let inClass = false
      while (i < n && code[i] !== '\n') {
        if (code[i] === '\\') i += 2
        else if (code[i] === '[') (inClass = true), i++
        else if (code[i] === ']') (inClass = false), i++
        else if (code[i] === '/' && !inClass) break
        else i++
      }
      i++
      while (i < n && /[a-z]/i.test(code[i])) i++
      token(start, i, 'regex', null)
      continue
    }
    if (/[\p{L}\p{Nl}$_\\]/u.test(c)) {
      while (i < n && /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$_\\‌‍]/u.test(code[i])) i++
      token(start, i, 'word', code.slice(start, i))
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1] ?? ''))) {
      while (i < n && /[0-9a-zA-Z_.]/.test(code[i])) i++
      token(start, i, 'number', null)
      continue
    }
    const value = PUNCT.find(p => code.startsWith(p, i)) ?? c
    i += value.length
    if (value === '(' || value === '[' || value === '{') {
      token(start, i, 'punct', value)
      depth++
      continue
    }
    if (value === ')' || value === ']' || value === '}') {
      depth = Math.max(0, depth - 1)
      token(start, i, 'punct', value)
      continue
    }
    if (value === ';' && depth === 0) {
      token(start, i, 'punct', value)
      last = { start: current, end: start }
      current = -1
      continue
    }
    token(start, i, 'punct', value)
  }
  if (current !== -1 && lastEnd > current) last = { start: current, end: lastEnd }
  return last && last.end > last.start ? last : null
}

const compiles = source => {
  try {
    new vm.Script(source)
    return true
  } catch {
    return false
  }
}

const wrapBody = body => `(async () => {\n${body}\n})()`

/** The function body to run: the code itself, with `return ( … )` around the last expression when there is one. */
export function wrapCode(code) {
  const plain = wrapBody(code)
  const range = lastStatement(code)
  if (range) {
    const statement = code.slice(range.start, range.end)
    const objectLiteral = statement.startsWith('{')
    if (objectLiteral || !STATEMENT_START.test(statement)) {
      const body = `${code.slice(0, range.start)}return (${statement}\n);${code.slice(range.end)}`
      const source = wrapBody(body)
      if (compiles(source)) return { source, returnsLast: true }
    }
  }
  return { source: plain, returnsLast: false }
}

const IMPORT_LINE = /^\s*import\s+(?:(.+?)\s+from\s+)?(['"])([^'"]+)\2\s*;?\s*$/
let importCount = 0

/** `import x from 'y'` lines at the top of the code become `await import('y')` lines, one for one, so line numbers
 * stay right (such lines never compile inside the function body the code runs in). Returns null when there are none. */
export function hoistImports(code) {
  const lines = code.split('\n')
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:\/\/.*)?$/.test(lines[i])) continue
    const match = IMPORT_LINE.exec(lines[i])
    if (!match) break
    const [, clause, , spec] = match
    const target = `await import(${JSON.stringify(spec)})`
    if (!clause) lines[i] = `${target};`
    else {
      const name = `__import${++importCount}`
      const out = [`const ${name} = ${target};`]
      const brace = clause.indexOf('{')
      const pieces = brace > 0 ? [clause.slice(0, brace).replace(/,\s*$/, ''), clause.slice(brace)] : clause.split(/,(?![^{]*})/)
      for (const piece of pieces.map(p => p.trim()).filter(Boolean)) {
        if (piece.startsWith('*')) out.push(`const ${piece.replace(/^\*\s*as\s+/, '')} = ${name};`)
        else if (piece.startsWith('{')) out.push(`const ${piece.replace(/\s+as\s+/g, ': ')} = ${name};`)
        else out.push(`const ${piece} = ${name}.default ?? ${name};`)
      }
      lines[i] = out.join(' ')
    }
    changed = true
  }
  return changed ? lines.join('\n') : null
}

/** Code that was written inside a template literal sometimes arrives with its own backticks still escaped
 * (`$\`npm test\``), which never compiles. Returns the code with those backslashes removed (and `\${` inside such a
 * template turned back into `${`), or null when no escaped backtick stands outside a string, template or comment. */
export function unescapeBackticks(code) {
  const n = code.length
  const open = [] // one entry per open template literal: null in its text, else the brace depth where its ${ began
  let depth = 0
  let out = ''
  let changed = false
  let i = 0
  const copyTo = end => {
    out += code.slice(i, end)
    i = end
  }
  while (i < n) {
    const c = code[i]
    if (open.length && open.at(-1) === null) {
      // the text of a template literal
      if (c === '\\') copyTo(Math.min(n, i + 2))
      else if (c === '`') {
        open.pop()
        copyTo(i + 1)
      } else if (c === '$' && code[i + 1] === '{') {
        open[open.length - 1] = depth++
        copyTo(i + 2)
      } else copyTo(i + 1)
      continue
    }
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      copyTo(end === -1 ? n : end)
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      copyTo(end === -1 ? n : end + 2)
    } else if (c === '"' || c === "'") {
      let end = i + 1
      while (end < n && code[end] !== c && code[end] !== '\n') end += code[end] === '\\' ? 2 : 1
      copyTo(Math.min(n, end + 1))
    } else if (c === '`') {
      open.push(null)
      copyTo(i + 1)
    } else if (c === '\\' && code[i + 1] === '`') {
      const end = code.indexOf('\\`', i + 2)
      if (end === -1) return null
      out += `\`${code.slice(i + 2, end).replace(/\\\$\{/g, '${')}\``
      i = end + 2
      changed = true
    } else {
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (open.length && open.at(-1) === depth) open[open.length - 1] = null
      }
      copyTo(i + 1)
    }
  }
  return changed ? out : null
}

/** A fresh vm context holding the helpers and the Node globals code usually reaches for. With `dir`, the code's file
 * name sits in that folder, so `import('pkg')` finds the packages installed there. */
export function createEvaluator(globals = {}, { dir } = {}) {
  const host = globalThis
  const context = vm.createContext({
    ...pick(host, [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask',
      'structuredClone', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
      'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'performance', 'crypto', 'atob', 'btoa', 'navigator',
    ]),
    ...globals,
  })
  context.globalThis = context
  const importModuleDynamically = vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER
  let count = 0

  /** Runs `code`; resolves to the value it returns, rejects with what it throws. `timeoutMs` bounds the part that runs
   * before the first await (a synchronous endless loop); the caller bounds the rest. */
  function evaluate(code, { timeoutMs } = {}) {
    const name = `run-${++count}.js`
    const filename = dir ? path.join(dir, name) : name
    const options = { filename, lineOffset: -1, ...(importModuleDynamically ? { importModuleDynamically } : {}) }
    const compile = text => new vm.Script(wrapCode(hoistImports(text) ?? text).source, options)
    let promise
    let repaired = false
    try {
      let script
      try {
        script = compile(code)
      } catch (error) {
        // the one repair: backticks that arrive escaped outside a string, when removing the backslashes makes it compile
        const fixed = error?.name === 'SyntaxError' ? unescapeBackticks(code) : null
        if (fixed === null) throw error
        try {
          script = compile(fixed)
          repaired = true
        } catch {
          throw error
        }
      }
      promise = script.runInContext(context, { timeout: timeoutMs, breakOnSigint: false })
    } catch (error) {
      promise = Promise.reject(error)
    }
    return { filename, promise, repaired }
  }

  return { evaluate, context }
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}
