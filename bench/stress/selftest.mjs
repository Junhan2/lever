// Checks the benchmark itself: the generated project has the planted properties, every checker refuses the untouched
// project, and every checker accepts a correct solution. Run it after changing project.mjs or tasks.mjs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeProject, TIMEOUTS } from './project.mjs'
import { deadExports, dependentsOf, jsonFrom, TASKS, topErrors } from './tasks.mjs'

let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}
const fresh = options => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lever-stress-self-'))
  makeProject(dir, options)
  return dir
}
const edit = (dir, file, change) => writeFileSync(path.join(dir, file), change(readFileSync(path.join(dir, file), 'utf8')))
const task = key => TASKS.find(t => t.key === key)

const clean = fresh()
const dead = deadExports(clean)
check('seven planted dead exports', dead.length === 7, dead.join(' '))
const dependents = dependentsOf(clean, 'src/core/clock.mjs')
check('dependents exclude the independent services', dependents.length === 17 && !dependents.includes('src/services/taxes.mjs') && dependents.includes('src/services/search.mjs'), `${dependents.length} files`)
const top = topErrors(clean)
check('log has the planted top three', top.map(e => `${e.code}:${e.count}`).join(' ') === 'E_TIMEOUT:412 E_DB_CONN:311 E_RATE_LIMIT:207', JSON.stringify(top.map(e => e.first)))
check('jsonFrom reads fenced and bare JSON', JSON.stringify(jsonFrom('Here:\n```json\n["a", "b"]\n```')) === '["a","b"]' && jsonFrom('[{"code":"X","count":1,"first":"t"}]')[0].code === 'X' && jsonFrom('no json') === undefined)

// answers: wrong ones are refused, right ones accepted
check('dead-exports: right answer', task('dead-exports').check(clean, JSON.stringify(dead)) === true)
check('dead-exports: wrong answer', task('dead-exports').check(clean, JSON.stringify(dead.slice(1))) !== true)
check('dependents: right answer', task('dependents').check(clean, `\`\`\`json\n${JSON.stringify(dependents)}\n\`\`\``) === true)
check('dependents: wrong answer', task('dependents').check(clean, JSON.stringify([...dependents, 'src/services/taxes.mjs'])) !== true)
check('log-triage: right answer', task('log-triage').check(clean, JSON.stringify(top)) === true)
check('log-triage: wrong answer', task('log-triage').check(clean, JSON.stringify(top.map(e => ({ ...e, count: e.count + 1 })))) !== true)

// edits: the untouched project is refused, a correct change accepted
const bugs = fresh({ bugs: true })
check('fix-tests: untouched', task('fix-tests').check(bugs) !== true, String(task('fix-tests').check(bugs)))
for (const file of ['src/core/money.mjs', 'src/utils/text.mjs', 'src/utils/arrays.mjs']) writeFileSync(path.join(bugs, file), readFileSync(path.join(clean, file)))
check('fix-tests: fixed', task('fix-tests').check(bugs) === true)
edit(bugs, 'test/core.test.mjs', text => `${text}\n// touched\n`)
check('fix-tests: a changed test file is refused', task('fix-tests').check(bugs) !== true)

const move = fresh()
check('move-function: untouched', task('move-function').check(move) !== true, String(task('move-function').check(move)))
const slug = /export function slugify[\s\S]*?\n}\n\n/.exec(readFileSync(path.join(move, 'src/utils/text.mjs'), 'utf8'))[0]
writeFileSync(path.join(move, 'src/utils/slug.mjs'), slug.trimEnd() + '\n')
edit(move, 'src/utils/text.mjs', text => text.replace(slug, ''))
for (const file of JSON.parse(JSON.stringify(makeProject(fresh()))).filter(f => /\.mjs$/.test(f) && f !== 'src/utils/text.mjs')) {
  edit(move, file, text => {
    const line = /^import {([^}]*)} from '([^']*)text\.mjs'$/m.exec(text)
    if (!line || !/\bslugify\b/.test(line[1])) return text
    const rest = line[1].split(',').map(n => n.trim()).filter(n => n && n !== 'slugify')
    const next = [`import { slugify } from '${line[2]}slug.mjs'`, ...(rest.length ? [`import { ${rest.join(', ')} } from '${line[2]}text.mjs'`] : [])].join('\n')
    return text.replace(line[0], next)
  })
}
check('move-function: moved', task('move-function').check(move) === true, String(task('move-function').check(move)))

const feature = fresh()
check('add-feature: untouched', task('add-feature').check(feature) !== true)
edit(feature, 'src/utils/stats.mjs', text => `${text}\nexport function percentile(values, p) {\n  if (!values.length) return 0\n  const sorted = [...values].sort((a, b) => a - b)\n  const rank = (p / 100) * (sorted.length - 1)\n  const low = Math.floor(rank)\n  const high = Math.ceil(rank)\n  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low)\n}\n`)
edit(feature, 'test/stats.test.mjs', text => `${text.replace("import { mean, median }", "import { mean, median, percentile }")}\ntest('percentile', () => {\n  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3)\n})\n`)
check('add-feature: added', task('add-feature').check(feature) === true, String(task('add-feature').check(feature)))

const config = fresh()
check('apply-config: untouched', task('apply-config').check(config) !== true, String(task('apply-config').check(config)))
for (const [name, value] of Object.entries(TIMEOUTS)) edit(config, `src/services/${name}.mjs`, text => text.replace('export const timeoutMs = 3000', `export const timeoutMs = ${value}`))
check('apply-config: applied', task('apply-config').check(config) === true)

for (const dir of [clean, bugs, move, feature, config]) rmSync(dir, { recursive: true, force: true })
console.log(failed ? `${failed} checks failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
