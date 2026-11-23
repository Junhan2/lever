// read / write / edit / exists / ls, plus the undo journal. Every change keeps the file's earlier content so undo()
// can put it back; writes keep the file's mode because they rewrite it in place.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { escapeRegExp } from '../glob.mjs'
import { checkStep, expandHome } from './shell.mjs'

class EditError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EditError'
  }
}

const countOf = (text, part) => {
  let count = 0
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) count++
  return count
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length

/** Why `old` was not found, in a way that helps the next attempt. */
function missHint(text, old) {
  const squash = s => s.replace(/\s+/g, ' ').trim()
  const target = squash(old)
  if (target && squash(text).includes(target)) return 'it matches if whitespace is ignored: check indentation, tabs and line endings'
  const firstLine = old.split('\n').find(line => line.trim() !== '')?.trim()
  if (firstLine) {
    const at = text.indexOf(firstLine)
    if (at !== -1) return `its first line is at line ${lineAt(text, at)} but the rest differs`
  }
  return 'no part of it was found'
}

const leading = line => /^[ \t]*/.exec(line)[0]

/** Finds `oldText` in `text` when it is there with every line indented more or less by the same amount, or with other
 * line endings: what happens when the text was read with indentation added or dropped. Returns where it is and the
 * new text moved the same way, or null when there is no such place, more than one, or the lines moved unevenly. */
function looseMatch(text, oldText, newText) {
  const oldLines = oldText.replace(/\r\n/g, '\n').split('\n')
  const hasIndent = index => index > 0 || leading(oldLines[0]) !== ''
  const source = oldLines.map((line, index) => (hasIndent(index) ? '[ \\t]*' : '') + escapeRegExp(line.slice(leading(line).length))).join('\\r?\\n')
  const regex = new RegExp(source, 'g')
  const found = regex.exec(text)
  if (!found || found[0] === '' || regex.exec(text)) return null
  const foundLines = found[0].split(/\r?\n/)
  let shift = null // { extra, deeper }: the file's lines have `extra` more (deeper) or less at their start
  for (let index = 0; index < oldLines.length; index++) {
    if (!hasIndent(index) || oldLines[index].trim() === '') continue
    const [given, actual] = [leading(oldLines[index]), leading(foundLines[index])]
    const deeper = actual.length >= given.length
    const [long, brief] = deeper ? [actual, given] : [given, actual]
    if (!long.startsWith(brief)) return null
    const extra = long.slice(brief.length)
    if (shift && (shift.extra !== extra || (extra !== '' && shift.deeper !== deeper))) return null
    shift ??= { extra, deeper }
  }
  const extra = shift?.extra ?? ''
  let moved = newText.replace(/\r\n/g, '\n')
  if (extra) {
    moved = moved
      .split('\n')
      .map((line, index) => (!hasIndent(index) || line.trim() === '' ? line : shift.deeper ? extra + line : line.startsWith(extra) ? line.slice(extra.length) : line))
      .join('\n')
  }
  if (found[0].includes('\r\n')) moved = moved.replace(/\n/g, '\r\n')
  const unit = extra.includes('\t') ? 'tab' : 'space'
  const what = extra ? `each line indented ${extra.length} ${unit}${extra.length === 1 ? '' : 's'} ${shift.deeper ? 'more' : 'less'} than given` : 'other line endings than given'
  return { index: found.index, length: found[0].length, newText: moved, what }
}

/** How many single-character changes turn `a` into `b`, counted up to `limit`. */
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

/** Up to three of `names` that a person could have meant by `wanted`: another letter case, another extension, or a
 * slip of one or two characters. */
function closeNames(wanted, names) {
  const stem = name => name.toLowerCase().replace(/\.[^.]+$/, '')
  const target = wanted.toLowerCase()
  const scored = []
  for (const name of names) {
    const lower = name.toLowerCase()
    const score = lower === target ? 0 : stem(name) === stem(wanted) ? 1 : 1 + distance(lower, target, 2)
    if (score <= 3) scored.push([score, name])
  }
  return scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)).slice(0, 3).map(([, name]) => name)
}

/** What undo compares a file with, to see whether it changed since the run wrote it. */
export const fingerprint = data => createHash('sha256').update(data).digest('base64')

/** env: { projectDir, guard, run(), history } */
export function createFiles(env) {
  /** The absolute path for a helper's first argument. A grep match or a write result stands for its file. */
  const absolute = (input, helper) => {
    const given = input !== null && typeof input === 'object' ? (input.file ?? input.path) : input
    if (typeof given !== 'string' || given === '') {
      const got = input === '' ? 'an empty string' : input !== null && typeof input === 'object' ? 'an object without a file' : String(input)
      throw new TypeError(`${helper}(path): the path must be a non-empty string, got ${got}`)
    }
    return path.resolve(env.projectDir, expandHome(given))
  }
  const shown = file => {
    const relative = path.relative(env.projectDir, file)
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file
  }

  const check = (run, tool, input, label) => checkStep(env, run, tool, input, label)

  /** A file error in words that say what to try next: a folder where a file was meant, or a missing file with the
   * names beside it that are close. Other errors come back as they are. */
  async function explain(error, helper, file) {
    const again = message => Object.assign(new Error(`${helper}(${shown(file)}): ${message}`, { cause: error }), { code: error.code })
    if (error?.code === 'EISDIR') return again(`that is a folder. List it with ls('${shown(file)}') or glob('${shown(file)}/**').`)
    if (error?.code === 'ENOTDIR') return again('a part of that path is a file, not a folder.')
    if (error?.code !== 'ENOENT') return error
    const dir = path.dirname(file)
    let names
    try {
      names = await fs.readdir(dir)
    } catch {
      return again(`no such ${helper === 'ls' ? 'folder' : 'file'}, and the folder ${shown(dir)} does not exist either.`)
    }
    const close = closeNames(path.basename(file), names.filter(name => !env.guard.hidden?.(path.join(dir, name))))
    return again(`no such ${helper === 'ls' ? 'folder' : 'file'}.${close.length ? ` Close names in ${shown(dir) === dir ? dir : `${shown(dir)}/`}: ${close.join(', ')}` : ''}`)
  }

  // Changes to one file run one at a time, in the order they were asked for, so edits started together (Promise.all)
  // all land. An edit function that changes its own file again would wait for itself, so that is an error.
  const queues = new Map()
  const holding = new AsyncLocalStorage()
  function inTurn(file, work) {
    const held = holding.getStore()
    if (held?.has(file)) throw new EditError(`${shown(file)} is already being changed by the edit function that made this call; return the new text from that function instead`)
    const mine = (queues.get(file) ?? Promise.resolve()).then(() => holding.run(new Set(held).add(file), work))
    const tail = mine.catch(() => {})
    queues.set(file, tail)
    tail.then(() => {
      if (queues.get(file) === tail) queues.delete(file)
    })
    return mine
  }

  const remember = async (run, file) => {
    if (run.journal.has(file)) return
    run.journal.set(file, await fs.readFile(file).catch(() => null)) // null: the file did not exist before this run
  }

  async function read(input, options = {}) {
    const run = env.run()
    const file = absolute(input, 'read')
    const range = options.from || options.to ? { offset: options.from ?? 1, limit: (options.to ?? Infinity) - (options.from ?? 1) + 1 } : {}
    await check(run, 'Read', { file_path: file, ...range }, shown(file))
    const data = await fs.readFile(file).catch(async error => {
      throw await explain(error, 'read', file)
    })
    run.bytesIn += data.length
    run.step({ kind: 'read', label: shown(file), ok: true })
    if (options.encoding === 'buffer') return data
    let text = data.toString(options.encoding ?? 'utf8')
    if (options.from || options.to) {
      const lines = text.split('\n')
      text = lines.slice((options.from ?? 1) - 1, options.to ?? lines.length).join('\n')
    }
    return text
  }

  async function write(input, content) {
    const run = env.run()
    const file = absolute(input, 'write')
    const data =
      typeof content === 'string' || ArrayBuffer.isView(content) ? content : `${JSON.stringify(content, null, 2)}\n`
    const preview = typeof data === 'string' ? data : `<${data.byteLength} bytes>`
    return inTurn(file, async () => {
      await check(run, 'Write', { file_path: file, content: preview }, shown(file))
      await remember(run, file)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, data)
      const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
      run.step({ kind: 'write', label: shown(file), ok: true, changed: true })
      run.note(await env.guard.after('Write', { file_path: file, content: preview }, { filePath: file, success: true }))
      return { path: shown(file), bytes: size }
    })
  }

  /** edit(path, old, new, { all }) · edit(path, [[old, new], …], { all }) · edit(path, text => newText) */
  async function edit(input, first, second, third) {
    const run = env.run()
    const file = absolute(input, 'edit')
    let options = {}
    let pairs = null
    let transform = null
    if (typeof first === 'function') transform = first
    else if (Array.isArray(first)) {
      pairs = first
      options = second ?? {}
    } else {
      pairs = [[first, second]]
      options = third ?? {}
    }
    const edits = (pairs ?? []).map(([oldText, newText]) => ({
      old_string: String(oldText ?? ''),
      new_string: String(newText ?? ''),
      replace_all: Boolean(options.all),
    }))
    return inTurn(file, () => change(run, file, { edits, transform, all: Boolean(options.all) }))
  }

  /** The part of edit that reads, changes and writes the file; it runs while nothing else changes that file. */
  async function change(run, file, { edits, transform, all }) {
    const options = { all }
    let tool = edits.length === 1 ? 'Edit' : 'MultiEdit'
    let hookInput = edits.length === 1 ? { file_path: file, ...edits[0] } : { file_path: file, edits }
    // A function edit hands the whole file to the code, so it is checked as a read now and as a write of the new text
    // before anything is written.
    if (transform) await check(run, 'Read', { file_path: file }, shown(file))
    else await check(run, tool, hookInput, shown(file))
    const original = await fs.readFile(file, 'utf8').catch(async error => {
      throw await explain(error, 'edit', file)
    })
    run.bytesIn += Buffer.byteLength(original)

    let text = original
    let replaced = 0
    let added = 0
    let removed = 0
    if (transform) {
      text = await transform(original)
      if (typeof text !== 'string') throw new EditError(`edit(${shown(file)}, fn): the function must return the new text`)
      tool = 'Write'
      hookInput = { file_path: file, content: text }
      if (text !== original) await check(run, 'Write', hookInput, shown(file))
    } else {
      for (const { old_string: oldText, new_string: newText } of edits) {
        if (oldText === '') throw new EditError(`edit(${shown(file)}): the text to replace is empty`)
        const count = countOf(text, oldText)
        if (count === 0) {
          const loose = looseMatch(text, oldText, newText)
          if (!loose) throw new EditError(`edit(${shown(file)}): text not found (${missHint(text, oldText)})`)
          text = text.slice(0, loose.index) + loose.newText + text.slice(loose.index + loose.length)
          run.note([`edit(${shown(file)}): the text was found with ${loose.what}, and replaced there with the new text moved the same way`])
          replaced += 1
          continue
        }
        if (count > 1 && !options.all) {
          const lines = []
          for (let at = text.indexOf(oldText); at !== -1 && lines.length < 5; at = text.indexOf(oldText, at + oldText.length)) lines.push(lineAt(text, at))
          throw new EditError(`edit(${shown(file)}): text found ${count} times (lines ${lines.join(', ')}); add context or pass { all: true }`)
        }
        text = options.all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText)
        const times = options.all ? count : 1
        replaced += times
        const oldLines = oldText.split('\n').length
        const newLines = newText.split('\n').length
        added += Math.max(0, newLines - oldLines) * times
        removed += Math.max(0, oldLines - newLines) * times
      }
    }
    if (text === original) {
      run.step({ kind: 'edit', label: shown(file), ok: true, detail: 'unchanged' })
      return { path: shown(file), replaced, changed: false }
    }
    await remember(run, file)
    await fs.writeFile(file, text)
    run.step({ kind: 'edit', label: shown(file), ok: true, changed: true, detail: replaced ? `${replaced}×` : 'rewritten' })
    run.note(await env.guard.after(tool, hookInput, { filePath: file, success: true }))
    return { path: shown(file), replaced, added, removed, changed: true }
  }

  /** Resolves to true or false. It notes whether anything awaited it: `if (exists(p))` without await is always true,
   * and the run's reply says so. */
  function exists(input) {
    const run = env.run()
    const file = absolute(input, 'exists')
    const call = `exists('${shown(file)}')`
    run.loose.add(call)
    const found = check(run, 'Read', { file_path: file }, shown(file)).then(() =>
      fs.access(file).then(
        () => true,
        () => false,
      ),
    )
    found.catch(() => {}) // a refusal nobody awaits is covered by the note, not reported as a stray error
    const awaited = () => run.loose.delete(call)
    return {
      then: (onFulfilled, onRejected) => (awaited(), found.then(onFulfilled, onRejected)),
      catch: onRejected => (awaited(), found.catch(onRejected)),
      finally: onFinally => (awaited(), found.finally(onFinally)),
    }
  }

  async function ls(input = '.') {
    const run = env.run()
    const dir = absolute(input, 'ls')
    await check(run, 'Glob', { pattern: '*', path: dir }, shown(dir))
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(async error => {
      throw error?.code === 'ENOTDIR' ? Object.assign(new Error(`ls(${shown(dir)}): that is a file. Read it with read('${shown(dir)}').`, { cause: error }), { code: error.code }) : await explain(error, 'ls', dir)
    })
    run.step({ kind: 'ls', label: shown(dir), ok: true })
    return entries
      .filter(entry => !env.guard.hidden?.(path.join(dir, entry.name)))
      .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
  }

  /** Puts back the files the most recent changing run (or run `id`) touched. A file changed again since is skipped
   * unless { force: true }, so undo never destroys newer work. */
  async function undo(id, { force = false } = {}) {
    const run = env.run()
    const index = id === undefined ? env.history.length - 1 : env.history.findIndex(entry => entry.id === String(id))
    const target = env.history[index]
    if (!target) return { restored: [], skipped: [], note: 'nothing to undo' }
    const restored = []
    const skipped = []
    for (const [file, before] of target.journal) {
      const written = target.after.get(file)
      await inTurn(file, async () => {
        const now = await fs.readFile(file).catch(() => null)
        const unchangedSince = now === null ? written === null : written !== null && fingerprint(now) === written
        if (!unchangedSince && !force) {
          skipped.push(shown(file))
          return
        }
        await check(run, 'Write', { file_path: file, content: '<undo>' }, shown(file))
        if (before === null) await fs.rm(file, { force: true })
        else {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, before)
        }
        restored.push(shown(file))
      })
    }
    env.history.splice(index, 1)
    run.step({ kind: 'undo', label: `run ${target.id}`, ok: true, changed: restored.length > 0 })
    return { run: target.id, restored, skipped }
  }

  return { read, write, edit, exists, ls, undo }
}
