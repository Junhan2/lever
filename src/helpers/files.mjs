// read / write / edit / exists / ls, plus the undo journal. Every change keeps the file's earlier content so undo()
// can put it back; writes keep the file's mode because they rewrite it in place.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StepRefused } from './shell.mjs'

export class EditError extends Error {
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

/** env: { projectDir, guard, run(), history } */
export function createFiles(env) {
  const absolute = input => {
    if (typeof input !== 'string' || input === '') throw new TypeError('A path must be a non-empty string')
    const expanded = input === '~' || input.startsWith('~/') ? path.join(os.homedir(), input.slice(1)) : input
    return path.resolve(env.projectDir, expanded)
  }
  const shown = file => {
    const relative = path.relative(env.projectDir, file)
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file
  }

  const check = async (run, tool, input, label) => {
    const verdict = await env.guard.before(tool, input)
    run.note(verdict.notes)
    if (verdict.deny) {
      run.step({ kind: tool.toLowerCase(), label, ok: false, detail: 'refused' })
      throw new StepRefused(`${tool} ${label}`, verdict.deny)
    }
  }

  const remember = async (run, file) => {
    if (run.journal.has(file)) return
    try {
      run.journal.set(file, await fs.readFile(file))
    } catch {
      run.journal.set(file, null) // the file did not exist before this run
    }
  }

  async function read(input, options = {}) {
    const run = env.run()
    const file = absolute(input)
    const range = options.from || options.to ? { offset: options.from ?? 1, limit: (options.to ?? Infinity) - (options.from ?? 1) + 1 } : {}
    await check(run, 'Read', { file_path: file, ...range }, shown(file))
    const data = await fs.readFile(file)
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
    const file = absolute(input)
    const data =
      typeof content === 'string' || ArrayBuffer.isView(content) ? content : `${JSON.stringify(content, null, 2)}\n`
    const preview = typeof data === 'string' ? data : `<${data.byteLength} bytes>`
    await check(run, 'Write', { file_path: file, content: preview }, shown(file))
    await remember(run, file)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, data)
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
    run.step({ kind: 'write', label: shown(file), ok: true, changed: true })
    run.note(await env.guard.after('Write', { file_path: file, content: preview }, { filePath: file, success: true }))
    return { path: shown(file), bytes: size }
  }

  /** edit(path, old, new, { all }) · edit(path, [[old, new], …], { all }) · edit(path, text => newText) */
  async function edit(input, first, second, third) {
    const run = env.run()
    const file = absolute(input)
    const original = await fs.readFile(file, 'utf8')
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
    const hookInput =
      edits.length === 1 ? { file_path: file, ...edits[0] } : { file_path: file, edits: transform ? [] : edits }
    await check(run, edits.length === 1 ? 'Edit' : 'MultiEdit', hookInput, shown(file))

    let text = original
    let replaced = 0
    let added = 0
    let removed = 0
    if (transform) {
      text = await transform(original)
      if (typeof text !== 'string') throw new EditError(`edit(${shown(file)}, fn): the function must return the new text`)
    } else {
      for (const { old_string: oldText, new_string: newText } of edits) {
        if (oldText === '') throw new EditError(`edit(${shown(file)}): the text to replace is empty`)
        const count = countOf(text, oldText)
        if (count === 0) throw new EditError(`edit(${shown(file)}): text not found (${missHint(text, oldText)})`)
        if (count > 1 && !options.all) {
          const lines = []
          for (let at = text.indexOf(oldText); at !== -1 && lines.length < 5; at = text.indexOf(oldText, at + oldText.length)) lines.push(lineAt(text, at))
          throw new EditError(`edit(${shown(file)}): text found ${count} times (lines ${lines.join(', ')}); add context or pass { all: true }`)
        }
        text = options.all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText)
        replaced += options.all ? count : 1
        const oldLines = oldText.split('\n').length
        const newLines = newText.split('\n').length
        added += Math.max(0, newLines - oldLines) * (options.all ? count : 1)
        removed += Math.max(0, oldLines - newLines) * (options.all ? count : 1)
      }
    }
    if (text === original) {
      run.step({ kind: 'edit', label: shown(file), ok: true, detail: 'unchanged' })
      return { path: shown(file), replaced, changed: false }
    }
    await remember(run, file)
    await fs.writeFile(file, text)
    run.step({ kind: 'edit', label: shown(file), ok: true, changed: true, detail: replaced ? `${replaced}×` : 'rewritten' })
    run.note(await env.guard.after(edits.length === 1 ? 'Edit' : 'MultiEdit', hookInput, { filePath: file, success: true }))
    return { path: shown(file), replaced, added, removed, changed: true }
  }

  async function exists(input) {
    try {
      await fs.access(absolute(input))
      return true
    } catch {
      return false
    }
  }

  async function ls(input = '.') {
    const run = env.run()
    const dir = absolute(input)
    await check(run, 'Glob', { pattern: '*', path: dir }, shown(dir))
    const entries = await fs.readdir(dir, { withFileTypes: true })
    run.step({ kind: 'ls', label: shown(dir), ok: true })
    return entries.map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort()
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
      let now = null
      try {
        now = await fs.readFile(file)
      } catch {
        now = null
      }
      const unchangedSince = written === undefined || (now === null ? written === null : written !== null && now.equals(written))
      if (!unchangedSince && !force) {
        skipped.push(shown(file))
        continue
      }
      await check(run, 'Write', { file_path: file, content: '<undo>' }, shown(file))
      if (before === null) await fs.rm(file, { force: true })
      else {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, before)
      }
      restored.push(shown(file))
    }
    env.history.splice(index, 1)
    run.step({ kind: 'undo', label: `run ${target.id}`, ok: true, changed: restored.length > 0 })
    return { run: target.id, restored, skipped }
  }

  return { read, write, edit, exists, ls, undo, absolute, shown }
}
