// glob and grep. Both use ripgrep when it is on PATH (fast), and plain Node otherwise; both ways skip the same files:
// .git, hidden names, node_modules and what .gitignore files name. Paths come back relative to the project folder, so
// they can go straight into read() or edit().
import { spawn } from 'node:child_process'
import { existsSync, promises as fs, statSync } from 'node:fs'
import path from 'node:path'
import { types } from 'node:util'
import { escapeRegExp, GLOB_CHARS, globRoot, globToRegExp } from '../glob.mjs'
import { checkStep, eachLine, expandHome } from './shell.mjs'

const LINE_MAX = 300
const IN_MODULES = /(^|\/)node_modules(\/|$)/

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
      rest = eachLine(rest, chunk, line => !line || onLine(line))
      if (rest === null) {
        stopped = true
        child.kill()
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

/** The rules of one .gitignore file in the folder `base`. The usual subset: comments, `!` to take a path back, a
 * trailing `/` for folders only, a pattern with a `/` is anchored to the folder, any other matches at every depth. */
function ignoreRules(text, base) {
  const rules = []
  for (let line of text.split(/\r?\n/)) {
    line = line.trimEnd()
    if (!line || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    if (!line) continue
    try {
      rules.push({ base, negate, dirOnly, re: globToRegExp(anchored ? line : `**/${line}`) })
    } catch {
      // a pattern this matcher cannot read is left out
    }
  }
  return rules
}

async function rulesIn(dir) {
  try {
    return ignoreRules(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'), dir)
  } catch {
    return []
  }
}

/** Whether the rules ignore `full`: the last rule that matches decides. */
function isIgnored(rules, full, isDir) {
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (rule.re.test(toSlash(path.relative(rule.base, full)))) ignored = !rule.negate
  }
  return ignored
}

/** Files under the absolute folder `root`, as absolute paths, for when there is no ripgrep. scope: { hidden, ignored,
 * modules }. Unless `ignored`, the .gitignore files from `top` down to each folder apply, as they do for ripgrep. */
async function* walk(root, scope, top = root) {
  let rules = []
  const below = path.relative(top, root)
  if (!scope.ignored && below && !below.startsWith('..') && !path.isAbsolute(below)) {
    let dir = top
    for (const part of below.split(path.sep)) {
      rules = rules.concat(await rulesIn(dir))
      dir = path.join(dir, part)
    }
  }
  yield* walkFolder(root, scope, rules)
}

async function* walkFolder(dir, scope, rules) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  if (!scope.ignored && entries.some(entry => entry.name === '.gitignore')) rules = rules.concat(await rulesIn(dir))
  for (const entry of entries) {
    if (entry.name === '.git' || (!scope.hidden && entry.name.startsWith('.')) || (!scope.modules && entry.name === 'node_modules')) continue
    const isDir = entry.isDirectory()
    if (!isDir && !entry.isFile()) continue
    const full = path.join(dir, entry.name)
    if (rules.length && isIgnored(rules, full, isDir)) continue
    if (isDir) yield* walkFolder(full, scope, rules)
    else yield full
  }
}

/** env: { projectDir, guard, run(), rg } (rg: a path, null to use Node only, undefined to look on PATH) */
export function createSearch(env) {
  const rg = env.rg === undefined ? findRipgrep() : env.rg
  const absolute = input => path.resolve(env.projectDir, expandHome(input))
  // Which files a search sees, the same for ripgrep and for the Node walk. node_modules is left out even where no
  // .gitignore names it, unless the search asks for ignored files or points inside it.
  const scopeOf = (options, roots) => {
    const ignored = Boolean(options.ignored || options.all)
    return { hidden: Boolean(options.hidden || options.all), ignored, modules: ignored || roots.some(root => IN_MODULES.test(root)) }
  }
  const common = scope => {
    const args = ['--no-require-git', '--no-messages']
    if (scope.hidden) args.push('--hidden', '-g', '!.git')
    if (scope.ignored) args.push('--no-ignore')
    if (!scope.modules) args.push('-g', '!node_modules')
    return args
  }
  /** The project-relative (or, outside the project, absolute) name of a file the walk found. */
  const shownFile = (file, target) => (path.isAbsolute(target) ? file : toSlash(path.relative(env.projectDir, file)))

  /** Leaves out what a permission rule keeps from being read, and says how many. */
  const visible = (items, fileOf, run) => {
    const hidden = new Set([...new Set(items.map(fileOf))].filter(file => env.guard.hidden(absolute(file))))
    if (hidden.size === 0) return items
    run.note([`left out ${hidden.size} file${hidden.size === 1 ? '' : 's'} that permission rules keep from being read`])
    return items.filter(item => !hidden.has(fileOf(item)))
  }

  const check = (run, tool, input, label) => checkStep(env, run, tool, input, label)

  /** glob('src/**\/*.ts', { cwd, hidden, ignored, all, ignoreCase }) → sorted paths. Files only. */
  async function glob(pattern, options = {}) {
    if (typeof pattern !== 'string' || pattern === '') throw new TypeError('glob needs a pattern string')
    const run = env.run()
    let full = toSlash(expandHome(pattern))
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
      const scope = scopeOf(options, [full])
      if (rg) {
        const outcome = await ripgrep(rg, ['--files', ...common(scope), '--', root || '.'], env.projectDir, keep)
        if (outcome.code === 2 && files.length === 0 && outcome.stderr) run.note([`glob: ${outcome.stderr.split('\n')[0]}`])
      } else {
        for await (const file of walk(path.resolve(env.projectDir, root), scope, env.projectDir)) keep(shownFile(file, root))
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
    const fromRegExp = types.isRegExp(pattern)
    if (fromRegExp) {
      ignoreCase ||= pattern.flags.includes('i')
      pattern = pattern.source
    }
    if (typeof pattern !== 'string' || pattern === '') throw new TypeError('grep needs a pattern (string or RegExp)')
    const targets = [options.path ?? options.in ?? '.'].flat().map(target => stripDot(toSlash(expandHome(String(target)))) || '.')
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

    const scope = scopeOf(options, targets)
    const settings = { ...options, ignoreCase, before, after, max, mode, globs, run, scope }
    let result
    try {
      result = rg ? await ripgrepSearch(pattern, targets, settings) : await nodeSearch(pattern, targets, settings)
    } catch (error) {
      if (!error.badPattern || options.multiline) throw error
      // Code is written with JavaScript's expressions. Where ripgrep's engine has no word for one (lookbehind, a
      // backreference), JavaScript's own engine searches the same files. A string that is no expression in either
      // engine is searched for as plain text.
      try {
        result = await nodeSearch(pattern, targets, settings)
      } catch (second) {
        if (!second.badPattern || fromRegExp || options.fixed) throw second
        const plain = { ...settings, fixed: true }
        result = rg ? await ripgrepSearch(pattern, targets, plain) : await nodeSearch(pattern, targets, plain)
        run.note([`grep: "${pattern.length > 60 ? `${pattern.slice(0, 59)}…` : pattern}" is not a regular expression, so it was searched for as plain text (as with { fixed: true })`])
      }
    }

    if (Array.isArray(result)) {
      result = visible(result, item => (typeof item === 'string' ? item : item.file), run)
      if (mode === 'files_with_matches') result.sort()
    } else result = Object.fromEntries(visible(Object.entries(result).sort(([a], [b]) => (a < b ? -1 : 1)), ([file]) => file, run))
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
    if (outcome.code !== 2 || !outcome.stderr) return
    const error = new Error(`grep: ${outcome.stderr.split('\n').slice(0, 6).join('\n')}`)
    error.badPattern = /regex parse error|error parsing regex/i.test(outcome.stderr)
    throw error
  }

  async function ripgrepSearch(pattern, targets, { ignoreCase, fixed, word, multiline, globs, type, mode, before, after, max, run, scope }) {
    const args = common(scope)
    if (ignoreCase) args.push('-i')
    if (fixed) args.push('-F')
    if (word) args.push('-w')
    if (multiline) args.push('-U', '--multiline-dotall')
    for (const g of globs) args.push('-g', g)
    if (type) args.push('-t', type)
    args.push('-e', pattern)
    if (mode === 'content') {
      if (before) args.push('-B', String(before))
      if (after) args.push('-A', String(after))
      return ripgrepContent(args, targets, { after, max, run })
    }
    if (mode === 'files_with_matches') {
      const files = []
      failIfBroken(
        await ripgrep(rg, ['--files-with-matches', ...args, '--', ...targets], env.projectDir, line => {
          files.push(stripDot(toSlash(line)))
        }),
      )
      return files
    }
    const counts = {}
    failIfBroken(
      await ripgrep(rg, ['--count-matches', '--with-filename', ...args, '--', ...targets], env.projectDir, line => {
        const at = line.lastIndexOf(':')
        counts[stripDot(toSlash(line.slice(0, at)))] = Number(line.slice(at + 1))
      }),
    )
    return counts
  }

  /** The files a search without ripgrep's own matching looks at: ripgrep's list when it is there, else the walk. */
  async function searchFiles(targets, { globs, type, scope }) {
    const files = []
    if (rg) {
      const args = ['--files', ...common(scope)]
      for (const g of globs) args.push('-g', g)
      if (type) args.push('-t', type)
      failIfBroken(await ripgrep(rg, [...args, '--', ...targets], env.projectDir, line => void files.push(stripDot(toSlash(line)))))
      return files
    }
    const filters = globs.map(g => {
      const not = g.startsWith('!')
      const body = not ? g.slice(1) : g
      return { not, re: globToRegExp(body.includes('/') ? body : `**/${body}`) }
    })
    const positives = filters.filter(f => !f.not)
    const wanted = file => (positives.length === 0 || positives.some(f => f.re.test(file))) && !filters.some(f => f.not && f.re.test(file))
    for (const target of targets) {
      const full = path.resolve(env.projectDir, target)
      const info = await fs.stat(full).catch(() => null)
      if (!info) continue
      if (info.isFile()) files.push(target)
      else {
        for await (const file of walk(full, scope, env.projectDir)) {
          const shown = shownFile(file, target)
          if (wanted(shown)) files.push(shown)
        }
      }
    }
    return files
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

  /** Matches with JavaScript's own engine, file by file. */
  async function nodeSearch(pattern, targets, options) {
    if (options.multiline) throw new Error('grep { multiline } needs ripgrep (rg) on PATH')
    const source = options.fixed ? escapeRegExp(pattern) : pattern
    let regex
    try {
      regex = new RegExp(options.word ? `\\b(?:${source})\\b` : source, options.ignoreCase ? 'i' : '')
    } catch (error) {
      throw Object.assign(new Error(`grep: ${error.message}. To search for the text as it is, pass { fixed: true }.`), { badPattern: true })
    }
    const list = await searchFiles(targets, options)
    const matches = []
    const files = []
    const counts = {}
    let truncated = false
    const load = async file => {
      try {
        const full = path.resolve(env.projectDir, file)
        const info = await fs.stat(full)
        return info.size > 10 * 1024 * 1024 ? null : await fs.readFile(full)
      } catch {
        return null
      }
    }
    const visit = async (file, loading = load(file)) => {
      const data = await loading
      if (data === null || data.subarray(0, 8000).includes(0)) return
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
    // files are read up to 32 ahead but matched in order, so the results stay the same
    const ahead = []
    for (const file of list) {
      ahead.push([file, load(file)])
      if (ahead.length >= 32) await visit(...ahead.shift())
      if (truncated) break
    }
    while (ahead.length && !truncated) await visit(...ahead.shift())
    if (truncated) options.run.note([`grep stopped at ${options.max} matches; narrow the pattern or pass { max }`])
    return options.mode === 'files_with_matches' ? files : options.mode === 'count' ? counts : matches
  }

  return { glob, grep }
}
