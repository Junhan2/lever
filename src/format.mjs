// Turns what a run produced into the short text the model reads. Values made inside the code come from another
// realm (the REPL context), so type checks use tags and duck typing, never instanceof.
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tagOf = value => Object.prototype.toString.call(value).slice(8, -1)

export const isThenable = value =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function'
export const isShellResult = value => value !== null && typeof value === 'object' && value.__lever === 'shell'
export const isErrorLike = value => value !== null && typeof value === 'object' && tagOf(value) === 'Error'

/** Waits for promises the code returned inside an object or array, so `({ tests: $`npm test` })` shows the result.
 * A promise that fails inside the value shows as its error; the top-level value is awaited by the caller. */
export async function settle(value, depth = 3) {
  if (isThenable(value)) {
    try {
      value = await value
    } catch (error) {
      return error
    }
  }
  if (depth <= 0 || value === null || typeof value !== 'object' || isShellResult(value) || isErrorLike(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return value.some(isThenable) || depth > 1 ? Promise.all(value.map(item => settle(item, depth - 1))) : value
  }
  if (tagOf(value) !== 'Object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = await settle(item, depth - 1)
  return out
}

/** Keeps the start and the end: logs and test reports put their summary last. */
export function cutMiddle(text, max, note = '') {
  if (text.length <= max) return text
  const room = Math.max(0, max - 40 - note.length) // what the marker line leaves
  const head = Math.ceil(room * 0.6)
  const tail = room - head
  const cut = text.length - head - tail
  return `${text.slice(0, head)}\n…[${cut} chars cut${note}]…\n${tail ? text.slice(-tail) : ''}`
}

export function errorText(error) {
  if (!error || typeof error !== 'object') return String(error)
  const name = error.name && error.name !== 'Error' ? `${error.name}: ` : 'Error: '
  return `${name}${error.message ?? String(error)}`
}

export function shellText(result, max = 4000) {
  const out = (result.stdout ?? '').replace(/\s+$/, '')
  if (result.exitCode === 0 && !result.signal) return out === '' ? '(exit 0, no output)' : cutMiddle(out, max)
  const status = result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`
  const err = (result.stderr ?? '').replace(/\s+$/, '')
  const parts = [`${status}: ${result.command.length > 120 ? `${result.command.slice(0, 117)}…` : result.command}`]
  if (err) parts.push(cutMiddle(err, Math.floor(max * 0.6)))
  if (out) parts.push(cutMiddle(out, Math.floor(max * 0.4)))
  return parts.join('\n')
}

/** A JSON-safe copy with long strings and arrays cut, cycles marked, and code-made objects summarised. */
export function toPlain(value, { maxString = 2000, maxItems = 200, maxDepth = 6 } = {}) {
  const seen = new WeakSet()
  const walk = (v, depth) => {
    if (v === null || v === undefined) return v
    switch (typeof v) {
      case 'string':
        return cutMiddle(v, maxString)
      case 'number':
      case 'boolean':
        return v
      case 'bigint':
        return `${v}n`
      case 'function':
        return `[Function ${v.name || 'anonymous'}]`
      case 'symbol':
        return v.toString()
    }
    if (isShellResult(v)) return v.exitCode === 0 ? walk(v.stdout.replace(/\s+$/, ''), depth) : shellText(v, maxString)
    if (isErrorLike(v)) return errorText(v)
    if (ArrayBuffer.isView(v)) return `<${v.byteLength} bytes>`
    const tag = tagOf(v)
    if (tag === 'Date') return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString()
    if (tag === 'RegExp') return String(v)
    if (seen.has(v)) return '[Circular]'
    if (depth >= maxDepth) return Array.isArray(v) ? `[${v.length} items]` : '{…}'
    seen.add(v)
    let out
    if (tag === 'Map') out = walk(Object.fromEntries(v), depth)
    else if (tag === 'Set') out = walk([...v], depth)
    else if (Array.isArray(v)) {
      out = v.slice(0, maxItems).map(item => walk(item, depth + 1))
      if (v.length > maxItems) out.push(`…+${v.length - maxItems} more`)
    } else {
      out = {}
      for (const [key, item] of Object.entries(v)) {
        const plain = walk(item, depth + 1)
        if (plain !== undefined) out[key] = plain
      }
    }
    seen.delete(v)
    return out
  }
  return walk(value, 0)
}

const isPrimitive = v => v === null || ['string', 'number', 'boolean'].includes(typeof v)
const indent = text => text.replace(/^/gm, '  ')
const MORE = /^…\+\d+ more$/

/** A grep() match, also after the code filtered or mapped the list. */
export const isMatch = v =>
  v !== null && typeof v === 'object' && typeof v.file === 'string' && typeof v.line === 'number' && typeof v.text === 'string'

/** Matches the way grep prints them: `file:line:text`, context lines as `file-line-text`. */
function matchLines(items) {
  const out = []
  for (const m of items) {
    m.before?.forEach((text, i) => out.push(`${m.file}-${m.line - m.before.length + i}-${text}`))
    out.push(`${m.file}:${m.line}:${m.text}`)
    const next = m.line + m.text.split('\n').length
    m.after?.forEach((text, i) => out.push(`${m.file}-${next + i}-${text}`))
  }
  return out.join('\n')
}

/** Lists that read better as lines than as JSON: grep matches, and long lists of one-line strings (paths). */
function listText(items) {
  const tail = typeof items.at(-1) === 'string' && MORE.test(items.at(-1)) ? items.at(-1) : null
  const body = tail ? items.slice(0, -1) : items
  let text = null
  if (body.length && body.every(isMatch)) text = matchLines(body)
  else if (body.length > 1 && body.every(s => typeof s === 'string' && s !== '' && !s.includes('\n')) && JSON.stringify(body).length > 200) {
    text = [`(${body.length}${tail ? '+' : ''} items)`, ...body].join('\n')
  }
  if (text === null) return null
  return tail ? `${text}\n${tail}` : text
}

/** The returned value as text: strings as they are, shell results as their output, a top-level object as
 * `key: value` lines, grep matches and long path lists one per line, other arrays of objects one JSON per line,
 * anything else as compact JSON. */
export function render(value, limits = {}) {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (isShellResult(value)) return shellText(value, limits.maxString ?? 4000)
  if (isErrorLike(value)) return errorText(value)
  const allMatches = Array.isArray(value) && value.length > 0 && value.every(isMatch)
  const plain = toPlain(value, allMatches ? { ...limits, maxItems: Infinity } : limits)
  if (isPrimitive(plain)) return typeof plain === 'string' ? plain : JSON.stringify(plain)
  if (Array.isArray(plain)) {
    const list = listText(plain)
    if (list !== null) return list
    if (plain.every(isPrimitive)) return JSON.stringify(plain)
    return [`(${Array.isArray(value) ? value.length : plain.length} items)`, ...plain.map(item => JSON.stringify(item))].join('\n')
  }
  const lines = []
  for (const [key, item] of Object.entries(plain)) {
    const list = Array.isArray(item) ? listText(item) : null
    if (list !== null) lines.push(`${key}:\n${indent(list)}`)
    else if (typeof item === 'string' && item.includes('\n')) lines.push(`${key}:\n${indent(item)}`)
    else lines.push(`${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`)
  }
  return lines.join('\n')
}

/** Renders a value in at most `max` characters when it can. Nothing is cut when the whole text fits; otherwise the long
 * strings inside the value are cut in the middle, only as much as needed. `whole` is the uncut text. */
export function renderWithin(value, max) {
  const whole = render(value, { maxString: Infinity })
  let text = whole
  for (let maxString = max; text.length > max && maxString >= 200 && typeof value !== 'string'; maxString = Math.floor(maxString / 2)) {
    text = render(value, { maxString })
  }
  return { text, whole }
}

let fallbackDir = null

/** `dir` when it is a real folder owned by this user and closed to others (it is created that way when missing);
 * otherwise a fresh private folder. Another user on a shared /tmp cannot plant the folder or a link in its place. */
export function privateDir(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const info = lstatSync(dir)
    const mine = typeof process.getuid !== 'function' || info.uid === process.getuid()
    const closed = process.platform === 'win32' || (info.mode & 0o077) === 0
    if (info.isDirectory() && mine && closed) return dir
  } catch {
    // use the fallback
  }
  fallbackDir ??= mkdtempSync(path.join(os.tmpdir(), 'lever-'))
  return fallbackDir
}

/** Saves `text` under `dir` with an unguessable name and returns the path, or null when it cannot be written. */
export function spill(text, dir, label) {
  try {
    const file = path.join(privateDir(dir), `${label}-${randomBytes(4).toString('hex')}.txt`)
    writeFileSync(file, text, { mode: 0o600, flag: 'wx' })
    return file
  } catch {
    return null
  }
}

/** Caps the whole reply. When it is cut, the full text goes to a file and the reply says where. */
/** Caps a reply at maxOutput characters. When anything was left out, `whole` (the uncut text) goes to a file. */
export function capReply(text, { maxOutput, spillDir, label, whole = text }) {
  if (text.length <= maxOutput && whole === text) return { text, file: null }
  const file = spill(whole, spillDir, label)
  const note = file ? ` · full text: ${file}` : ''
  if (text.length <= maxOutput) return { text: `${text}\n…[long values cut in the middle${note}]`, file }
  return { text: cutMiddle(text, maxOutput, note), file }
}

export function bytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const seconds = ms => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
