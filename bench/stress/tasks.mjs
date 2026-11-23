// Seven tasks that take many dependent steps on the generated project, each with a checker that works out the right
// answer from the files. A checker gets the project folder after the run and the model's final reply, and returns
// true or a short reason for the failure.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeProject, TIMEOUTS } from './project.mjs'

const listFiles = (dir, base = dir) =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => (entry.isDirectory() ? listFiles(path.join(dir, entry.name), base) : [path.relative(base, path.join(dir, entry.name))]))
    .sort()
const sourceFiles = dir => listFiles(path.join(dir, 'src')).filter(file => file.endsWith('.mjs')).map(file => `src/${file}`)
const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8')

/** Runs the project's tests: { ok, tests, fail }. */
export function runTests(dir) {
  const result = spawnSync('npm', ['test'], { cwd: dir, encoding: 'utf8', timeout: 120_000 })
  const out = `${result.stdout}${result.stderr}`
  const count = label => Number(new RegExp(`^ℹ ${label} (\\d+)`, 'm').exec(out)?.[1] ?? -1)
  return { ok: result.status === 0, tests: count('tests'), fail: count('fail') }
}

/** The last JSON array (or, failing that, object) in a reply, with or without a code fence around it. */
export function jsonFrom(answer) {
  const text = String(answer)
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const end = text.lastIndexOf(close)
    if (end === -1) continue
    for (let start = text.lastIndexOf(open, end); start !== -1; start = start === 0 ? -1 : text.lastIndexOf(open, start - 1)) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        // an inner bracket: try the one before it
      }
    }
  }
  return undefined
}

const sameSet = (got, want) => Array.isArray(got) && got.length === want.length && [...got].map(String).sort().join('\n') === [...want].sort().join('\n')

/** "path#name" for every export whose name appears in no other file under src/ or test/. */
export function deadExports(dir) {
  const files = [...sourceFiles(dir), ...listFiles(path.join(dir, 'test')).map(file => `test/${file}`)]
  const texts = Object.fromEntries(files.map(file => [file, read(dir, file)]))
  const dead = []
  for (const file of sourceFiles(dir)) {
    for (const match of texts[file].matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)) {
      const word = new RegExp(`\\b${match[1]}\\b`)
      if (!files.some(other => other !== file && word.test(texts[other]))) dead.push(`${file}#${match[1]}`)
    }
  }
  return dead.sort()
}

/** Files under src/ that reach `target` through import or export-from lines. */
export function dependentsOf(dir, target) {
  const imports = {}
  for (const file of sourceFiles(dir)) {
    imports[file] = [...read(dir, file).matchAll(/^(?:import|export)\b[^'"\n]*from\s+['"]([^'"]+)['"]/gm)]
      .filter(match => match[1].startsWith('.'))
      .map(match => path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])))
  }
  const found = new Set([target])
  for (let grew = true; grew; ) {
    grew = false
    for (const [file, list] of Object.entries(imports)) {
      if (!found.has(file) && list.some(dep => found.has(dep))) {
        found.add(file)
        grew = true
      }
    }
  }
  found.delete(target)
  return [...found].sort()
}

/** The three most frequent codes among ERROR lines, with the first time each appears. */
export function topErrors(dir) {
  const seen = new Map()
  for (const line of read(dir, 'logs/app.log').split('\n')) {
    const match = /^(\S+) ERROR \[[^\]]+\] .*?\bcode=(\w+)/.exec(line)
    if (!match) continue
    const entry = seen.get(match[2]) ?? { code: match[2], count: 0, first: match[1] }
    entry.count += 1
    seen.set(match[2], entry)
  }
  return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 3)
}

function pristineTests(options) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lever-stress-pristine-'))
  makeProject(dir, options)
  const files = Object.fromEntries(listFiles(path.join(dir, 'test')).map(file => [file, read(dir, `test/${file}`)]))
  rmSync(dir, { recursive: true, force: true })
  return files
}

export const TASKS = [
  {
    key: 'fix-tests',
    name: 'Fix three bugs until the tests pass',
    fixture: { bugs: true },
    prompt: 'Some tests in this project fail (run `npm test`). Find the bugs in the source files under src/ and fix them so that every test passes. Do not change any file under test/. Reply with only the list of files you changed.',
    check(dir) {
      const before = pristineTests({ bugs: true })
      const now = listFiles(path.join(dir, 'test'))
      if (now.length !== Object.keys(before).length || now.some(file => read(dir, `test/${file}`) !== before[file])) return 'a test file was changed'
      const tests = runTests(dir)
      return (tests.ok && tests.fail === 0) || `${tests.fail} tests still fail`
    },
  },
  {
    key: 'move-function',
    name: 'Move a function to a new module and update every import',
    prompt: 'Move the function `slugify` out of src/utils/text.mjs into a new module src/utils/slug.mjs. Update every import in the project (src/ and test/) so that slugify is imported from the new module, and remove it from text.mjs. The tests must still pass. Reply with only the list of files you changed or created.',
    check(dir) {
      if (!existsSync(path.join(dir, 'src/utils/slug.mjs'))) return 'src/utils/slug.mjs is missing'
      if (/\bslugify\b/.test(read(dir, 'src/utils/text.mjs'))) return 'text.mjs still mentions slugify'
      const stale = [...sourceFiles(dir), ...listFiles(path.join(dir, 'test')).map(file => `test/${file}`)].filter(file => /import\s*{[^}]*\bslugify\b[^}]*}\s*from\s*['"][^'"]*text\.mjs['"]/.test(read(dir, file)))
      if (stale.length) return `still imported from text.mjs in ${stale.join(', ')}`
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e', "import { slugify } from './src/utils/slug.mjs'; if (slugify(' A b! ') !== 'a-b') process.exit(1)"], { cwd: dir, encoding: 'utf8' })
      if (probe.status !== 0) return 'slug.mjs does not export a working slugify'
      const tests = runTests(dir)
      return (tests.ok && tests.fail === 0 && tests.tests >= 42) || `tests: ${tests.tests} run, ${tests.fail} fail`
    },
  },
  {
    key: 'dead-exports',
    name: 'Find the exports nothing else uses',
    prompt: 'List the exports of this project that nothing else uses. An export counts as unused when its name does not appear as a whole word in any other file under src/ or test/. Check every `export function`, `export const` and `export class` in the .mjs files under src/. Reply with only a JSON array of strings in the form "path#name" (for example "src/core/money.mjs#roundCents"), sorted.',
    check: (dir, answer) => sameSet(jsonFrom(answer), deadExports(dir)) || `expected ${JSON.stringify(deadExports(dir))}`,
  },
  {
    key: 'log-triage',
    name: 'Triage a 4 MB log',
    prompt: 'logs/app.log has one line per event: time, level, [service], then text with a `code=...` value. Look only at lines whose level is ERROR. Find the three most frequent codes among them. Reply with only a JSON array, most frequent first, of objects {"code": string, "count": number, "first": string}, where first is the timestamp of the earliest ERROR line with that code.',
    check(dir, answer) {
      const got = jsonFrom(answer)
      const want = topErrors(dir)
      const same = Array.isArray(got) && got.length === 3 && want.every((entry, i) => got[i]?.code === entry.code && Number(got[i]?.count) === entry.count && got[i]?.first === entry.first)
      return same || `expected ${JSON.stringify(want)}`
    },
  },
  {
    key: 'add-feature',
    name: 'Add a function with tests',
    prompt: 'Add a function `percentile(values, p)` to src/utils/stats.mjs. It returns the p-th percentile (p from 0 to 100) of a list of numbers with linear interpolation: sort the values, take rank = (p / 100) * (n - 1), and interpolate between the values at floor(rank) and ceil(rank). An empty list gives 0. Add at least three tests for it to test/stats.test.mjs and make sure the whole test suite passes. Reply with only the list of files you changed.',
    check(dir) {
      const probe = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', "import { percentile } from './src/index.mjs'; const ok = percentile([1, 2, 3, 4, 5], 50) === 3 && percentile([10, 20], 25) === 12.5 && percentile([], 50) === 0 && percentile([5, 1, 3], 100) === 5 && percentile([5, 1, 3], 0) === 1; process.exit(ok ? 0 : 1)"],
        { cwd: dir, encoding: 'utf8' },
      )
      if (probe.status !== 0) return 'percentile gives wrong values or is not exported'
      if (!/\bpercentile\b/.test(read(dir, 'test/stats.test.mjs'))) return 'no test mentions percentile'
      const tests = runTests(dir)
      return (tests.ok && tests.fail === 0 && tests.tests >= 43) || `tests: ${tests.tests} run, ${tests.fail} fail`
    },
  },
  {
    key: 'apply-config',
    name: 'Apply a config file to fifteen modules',
    prompt: 'config/timeouts.json lists a timeout for each service. Every file in src/services/ has a line `export const timeoutMs = ...`. Set each service\'s timeoutMs to the value listed for it in the config (the key is the file name without .mjs). Then run the tests. Reply with only the number of files you changed.',
    check(dir) {
      const wrong = Object.entries(TIMEOUTS).filter(([name, value]) => Number(/^export const timeoutMs = ([\d_]+)/m.exec(read(dir, `src/services/${name}.mjs`))?.[1]?.replace(/_/g, '')) !== value)
      if (wrong.length) return `${wrong.length} services have the wrong timeout (${wrong.slice(0, 3).map(([name]) => name).join(', ')})`
      const tests = runTests(dir)
      return (tests.ok && tests.fail === 0) || `${tests.fail} tests fail`
    },
  },
  {
    key: 'dependents',
    name: 'Find every file that depends on a module',
    prompt: 'Which files under src/ depend on src/core/clock.mjs, directly or through other files? Follow `import ... from` and `export ... from` lines transitively. Reply with only a JSON array of the file paths (for example "src/core/ids.mjs"), sorted. Do not include clock.mjs itself.',
    check: (dir, answer) => sameSet(jsonFrom(answer), dependentsOf(dir, 'src/core/clock.mjs')) || `expected ${JSON.stringify(dependentsOf(dir, 'src/core/clock.mjs'))}`,
  },
]
