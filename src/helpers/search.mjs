// glob and grep. Both use ripgrep when it is on PATH (fast, honours .gitignore), and plain Node otherwise.
// Paths come back relative to the project folder, so they can go straight into read() or edit().
import { spawn } from 'node:child_process'
import { existsSync, promises as fs, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { escapeRegExp, GLOB_CHARS, globRoot, globToRegExp } from '../glob.mjs'
import { StepRefused } from './shell.mjs'

const LINE_MAX = 300
const SKIP_DIRS = new Set(['.git', 'node_modules'])

export function findRipgrep() {
  if (process.env.LEVER_RG === 'off') return null
  if (process.env.LEVER_RG) return process.env.LEVER_RG
  const names = process.platform === 'win32' ? ['rg.exe', 'rg'] : ['rg']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (dir && statSync(candidate).isFile()) return candidate
      } catch {
        // not here
      }
    }
  }
  return null
}

const toSlash = text => (process.platform === 'win32' ? text.replace(/\\/g, '/') : text)
const stripDot = text => (text.startsWith('./') ? text.slice(2) : text)

function cutLine(text, at = 0) {
  if (text.length <= LINE_MAX) return text
  const start = Math.max(0, Math.min(at - 100, text.length - LINE_MAX))
  return `${start > 0 ? '…' : ''}${text.slice(start, start + LINE_MAX)}${start + LINE_MAX < text.length ? '…' : ''}`
}

/** Runs rg and hands each stdout line to onLine; onLine returns false to stop early. */
function ripgrep(rg, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(rg, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let rest = ''
    let stderr = ''
    let stopped = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (stopped) return
      const lines = (rest + chunk).split('\n')
      rest = lines.pop()
      for (const line of lines) {
        if (line && onLine(line) === false) {
          stopped = true
          child.kill()
          return
        }
      }
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < 4000) stderr += chunk
    })
    child.on('error', reject)
    child.on('close', code => {
      if (!stopped && rest) onLine(rest)
      resolve({ code: stopped ? 0 : code, stderr: stderr.trim(), stopped })
    })
  })
}

async function* walk(dir, { hidden, ignored }) {
  let entries
  try {
    entries = await fs.readdir(dir || '.', { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '.git' || (!hidden && entry.name.startsWith('.')) || (!ignored && SKIP_DIRS.has(entry.name))) continue
    const child = dir ? `${dir.replace(/\/$/, '')}/${entry.name}` : entry.name
    if (entry.isDirectory()) yield* walk(child, { hidden, ignored })
    else if (entry.isFile()) yield child
  }
}

/** env: { projectDir, guard, run(), rg } (rg: a path, null to use Node only, undefined to look on PATH) */
export function createSearch(env) {
  const rg = env.rg === undefined ? findRipgrep() : env.rg
  const expand = input => (input === '~' || input.startsWith('~/') ? path.join(os.homedir(), input.slice(1)) : input)
  const absolute = input => path.resolve(env.projectDir, expand(input))
  const common = options => {
    const args = ['--no-require-git', '--no-messages']
    if (options.hidden || options.all) args.push('--hidden', '-g', '!.git')
    if (options.ignored || options.all) args.push('--no-ignore')
    return args
  }

  /** Leaves out what a permission rule keeps from being read, and says how many. */
  const visible = (items, fileOf, run) => {
    if (!env.guard.hidden) return items
    const kept = items.filter(item => !env.guard.hidden(absolute(fileOf(item))))
    const dropped = new Set(items.filter(item => !kept.includes(item)).map(fileOf)).size
    if (dropped) run.note([`left out ${dropped} file${dropped === 1 ? '' : 's'} that permission rules keep from being read`])
    return kept
  }

  const check = async (run, tool, input, label) => {
    const verdict = await env.guard.before(tool, input)
    run.note(verdict.notes)
    if (verdict.deny) {
      run.step({ kind: tool.toLowerCase(), label, ok: false, detail: 'refused' })
      throw new StepRefused(`${tool} ${label}`, verdict.deny)
    }
  }

  /** glob('src/**\/*.ts', { cwd, hidden, ignored, all, ignoreCase }) → sorted paths. Files only. */
  async function glob(pattern, options = {}) {
    if (typeof pattern !== 'string' || pattern === '') throw new TypeError('glob needs a pattern string')
    const run = env.run()
    let full = toSlash(expand(pattern))
    if (options.cwd && !path.isAbsolute(full)) full = toSlash(path.join(options.cwd, full))
    full = stripDot(path.posix.normalize(full))
    const root = globRoot(full)
    await check(run, 'Glob', { pattern: full, path: absolute(root || '.') }, full)
    const started = Date.now()
    let files = []
    if (!GLOB_CHARS.test(full)) {
      files = existsSync(absolute(full)) && statSync(absolute(full)).isFile() ? [full] : []
    } else {
      const matcher = globToRegExp(full, options)
      const keep = line => {
        const file = stripDot(toSlash(line))
        if (matcher.test(file)) files.push(file)
      }
      if (rg) {
        const outcome = await ripgrep(rg, ['--files', ...common(options), '--', root || '.'], env.projectDir, keep)
        if (outcome.code === 2 && files.length === 0 && outcome.stderr) run.note([`glob: ${outcome.stderr.split('\n')[0]}`])
      } else {
        const base = root ? (path.isAbsolute(root) ? root : path.join(env.projectDir, root)) : env.projectDir
        for await (const file of walk(base, options)) {
          const shown = path.isAbsolute(root) ? file : toSlash(path.relative(env.projectDir, file))
          keep(shown)
        }
      }
    }
    files = visible(files, file => file, run)
    files.sort()
    run.bytesIn += files.reduce((sum, file) => sum + file.length + 1, 0)
    run.step({ kind: 'glob', label: full, ok: true, detail: `${files.length} files`, ms: Date.now() - started })
    run.note(await env.guard.after('Glob', { pattern: full }, { numFiles: files.length, filenames: files.slice(0, 100) }))
    return files
  }

  /** grep(pattern, { path, glob, type, ignoreCase, fixed, word, multiline, context, before, after, max, files, count,
   * hidden, ignored, all }) → [{ file, line, text, before?, after? }], or paths with { files: true }, or
   * { path: n } with { count: true }. `pattern` may be a RegExp; its i flag is honoured. */
  async function grep(pattern, options = {}) {
    const run = env.run()
    let ignoreCase = Boolean(options.ignoreCase ?? options.i)
    if (pattern instanceof RegExp || Object.prototype.toString.call(pattern) === '[object RegExp]') {
      ignoreCase ||= pattern.flags.includes('i')
      pattern = pattern.source
    }
    if (typeof pattern !== 'string' || pattern === '') throw new TypeError('grep needs a pattern (string or RegExp)')
    const targets = [options.path ?? options.in ?? '.'].flat().map(target => stripDot(toSlash(expand(String(target)))) || '.')
    const mode = options.files ? 'files_with_matches' : options.count ? 'count' : 'content'
    const before = options.before ?? options.context ?? 0
    const after = options.after ?? options.context ?? 0
    const max = options.max ?? 2000
    const globs = [options.glob ?? []].flat()
    for (const target of targets) {
      const input = { pattern, path: absolute(target), output_mode: mode }
      if (globs.length) input.glob = globs.join(',')
      if (options.type) input.type = options.type
      if (ignoreCase) input['-i'] = true
      if (before) input['-B'] = before
      if (after) input['-A'] = after
      if (options.multiline) input.multiline = true
      await check(run, 'Grep', input, `${pattern} in ${target}`)
    }
    const started = Date.now()
    const label = `${pattern}${targets.length === 1 && targets[0] === '.' ? '' : ` in ${targets.join(' ')}`}`

    let result
    if (rg) {
      const args = [...common(options)]
      if (ignoreCase) args.push('-i')
      if (options.fixed) args.push('-F')
      if (options.word) args.push('-w')
      if (options.multiline) args.push('-U', '--multiline-dotall')
      for (const g of globs) args.push('-g', g)
      if (options.type) args.push('-t', options.type)
      args.push('-e', pattern)
      if (mode === 'content') {
        if (before) args.push('-B', String(before))
        if (after) args.push('-A', String(after))
        result = await ripgrepContent(args, targets, { after, max, run })
      } else if (mode === 'files_with_matches') {
        const files = []
        const outcome = await ripgrep(rg, ['--files-with-matches', ...args, '--', ...targets], env.projectDir, line => {
          files.push(stripDot(toSlash(line)))
        })
        failIfBroken(outcome)
        result = files.sort()
      } else {
        const counts = {}
        const outcome = await ripgrep(rg, ['--count-matches', '--with-filename', ...args, '--', ...targets], env.projectDir, line => {
          const at = line.lastIndexOf(':')
          counts[stripDot(toSlash(line.slice(0, at)))] = Number(line.slice(at + 1))
        })
        failIfBroken(outcome)
        result = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)))
      }
    } else {
      result = await nodeGrep(pattern, targets, { ...options, ignoreCase, before, after, max, mode, globs, run })
    }

    if (Array.isArray(result)) result = visible(result, item => (typeof item === 'string' ? item : item.file), run)
    else result = Object.fromEntries(visible(Object.entries(result), ([file]) => file, run))
    const size = Array.isArray(result) ? result.length : Object.keys(result).length
    run.step({ kind: 'grep', label, ok: true, detail: `${size} ${mode === 'content' ? 'matches' : 'files'}`, ms: Date.now() - started })
    const response =
      mode === 'content'
        ? { mode, numLines: result.length, content: result.slice(0, 200).map(m => `${m.file}:${m.line}:${m.text}`).join('\n') }
        : { mode, numFiles: size, filenames: (Array.isArray(result) ? result : Object.keys(result)).slice(0, 100) }
    run.note(await env.guard.after('Grep', { pattern, path: absolute(targets[0]) }, response))
    return result
  }

  function failIfBroken(outcome) {
    if (outcome.code === 2 && outcome.stderr) throw new Error(`grep: ${outcome.stderr.split('\n').slice(0, 6).join('\n')}`)
  }

  async function ripgrepContent(args, targets, { after, max, run }) {
    const matches = []
    let pending = [] // context lines seen since the last match, kept for the next match's `before`
    let last = null
    let truncated = false
    const outcome = await ripgrep(rg, ['--json', ...args, '--', ...targets], env.projectDir, line => {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return true
      }
      if (event.type === 'begin') {
        pending = []
        last = null
        return true
      }
      if (event.type !== 'match' && event.type !== 'context') return true
      const data = event.data
      const file = stripDot(toSlash(data.path.text ?? Buffer.from(data.path.bytes, 'base64').toString()))
      const raw = (data.lines.text ?? Buffer.from(data.lines.bytes, 'base64').toString()).replace(/\r?\n$/, '')
      run.bytesIn += Buffer.byteLength(raw) + 1
      if (event.type === 'context') {
        const lastEnd = last ? last.line + last.text.split('\n').length - 1 : -Infinity
        if (last && data.line_number <= lastEnd + after) (last.after ??= []).push(cutLine(raw))
        else pending.push({ line: data.line_number, text: cutLine(raw) })
        return true
      }
      if (matches.length >= max) {
        truncated = true
        return false
      }
      const start = data.submatches?.[0]?.start ?? 0
      const at = start ? Buffer.from(raw).subarray(0, start).toString().length : 0
      const item = { file, line: data.line_number, text: raw.includes('\n') ? raw.split('\n').map(l => cutLine(l)).join('\n') : cutLine(raw, at) }
      const lines = pending.filter(entry => entry.line < item.line).map(entry => entry.text)
      if (lines.length) item.before = lines
      pending = []
      matches.push(item)
      last = item
      return true
    })
    failIfBroken(outcome)
    if (truncated) run.note([`grep stopped at ${max} matches; narrow the pattern or pass { max }`])
    return matches
  }

  async function nodeGrep(pattern, targets, options) {
    if (options.multiline) throw new Error('grep { multiline } needs ripgrep (rg) on PATH')
    const source = options.fixed ? escapeRegExp(pattern) : pattern
    const regex = new RegExp(options.word ? `\\b(?:${source})\\b` : source, options.ignoreCase ? 'i' : '')
    const fileFilters = options.globs.map(g => (g.startsWith('!') ? { not: true, re: globToRegExp(g.slice(1).includes('/') ? g.slice(1) : `**/${g.slice(1)}`) } : { not: false, re: globToRegExp(g.includes('/') ? g : `**/${g}`) }))
    const wanted = file => {
      const positives = fileFilters.filter(f => !f.not)
      if (positives.length && !positives.some(f => f.re.test(file))) return false
      return !fileFilters.some(f => f.not && f.re.test(file))
    }
    const matches = []
    const files = []
    const counts = {}
    let truncated = false
    const visit = async file => {
      const full = path.resolve(env.projectDir, file)
      let data
      try {
        const info = await fs.stat(full)
        if (info.size > 10 * 1024 * 1024) return
        data = await fs.readFile(full)
      } catch {
        return
      }
      if (data.subarray(0, 8000).includes(0)) return
      const lines = data.toString('utf8').split(/\r?\n/)
      let count = 0
      let lastAfterEnd = 0
      for (let index = 0; index < lines.length; index++) {
        if (!regex.test(lines[index])) continue
        count++
        if (options.mode !== 'content') continue
        if (matches.length >= options.max) {
          truncated = true
          break
        }
        const item = { file, line: index + 1, text: cutLine(lines[index]) }
        const from = Math.max(lastAfterEnd, index - options.before)
        if (from < index) item.before = lines.slice(from, index).map(l => cutLine(l))
        if (options.after) {
          const end = Math.min(lines.length, index + 1 + options.after)
          let stop = index + 1
          while (stop < end && !regex.test(lines[stop])) stop++
          if (stop > index + 1) item.after = lines.slice(index + 1, stop).map(l => cutLine(l))
          lastAfterEnd = stop
        } else lastAfterEnd = index + 1
        options.run.bytesIn += item.text.length + 1
        matches.push(item)
      }
      if (count) {
        files.push(file)
        counts[file] = count
      }
    }
    for (const target of targets) {
      const full = path.resolve(env.projectDir, target)
      let info
      try {
        info = await fs.stat(full)
      } catch {
        continue
      }
      if (info.isFile()) await visit(target)
      else {
        for await (const file of walk(full, options)) {
          const shown = path.isAbsolute(target) ? file : toSlash(path.relative(env.projectDir, file))
          if (wanted(shown)) await visit(shown)
          if (truncated) break
        }
      }
    }
    if (truncated) options.run.note([`grep stopped at ${options.max} matches; narrow the pattern or pass { max }`])
    if (options.mode === 'files_with_matches') return files.sort()
    if (options.mode === 'count') return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)))
    return matches
  }

  return { glob, grep, ripgrep: rg }
}

export { globRoot, globToRegExp }
