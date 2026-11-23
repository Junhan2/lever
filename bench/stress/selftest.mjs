// Checks the benchmark itself: the generated project has the planted properties, every checker refuses the untouched
// project, and every checker accepts a correct solution. Run it after changing project.mjs or tasks.mjs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { CHAIN, HISTORY, historySubject, makeProject, TIMEOUTS } from './project.mjs'
import { deadExports, dependentsOf, jsonFrom, runTests, TASKS, TESTS, topErrors } from './tasks.mjs'

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
check(`the untouched project has ${TESTS} passing tests`, runTests(clean).tests === TESTS && runTests(clean).fail === 0)
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

const big = fresh({ ruleBugs: true })
check('big-file-fix: untouched', task('big-file-fix').check(big) !== true, String(task('big-file-fix').check(big)))
writeFileSync(path.join(big, 'src/engine/rules.mjs'), readFileSync(path.join(clean, 'src/engine/rules.mjs')))
check('big-file-fix: fixed', task('big-file-fix').check(big) === true)

const api = fresh()
check('api-change: untouched', task('api-change').check(api) !== true, String(task('api-change').check(api)))
edit(api, 'src/core/money.mjs', text => text.replace("export function formatMoney(amount, currency = 'USD') {", "export function formatMoney({ amount, currency = 'USD' }) {"))
edit(api, 'test/core.test.mjs', text => text.replace('formatMoney(3)', 'formatMoney({ amount: 3 })').replace("formatMoney(3.5, 'EUR')", "formatMoney({ amount: 3.5, currency: 'EUR' })"))
check('api-change: callers not updated yet', /still called the old way/.test(String(task('api-change').check(api))), String(task('api-change').check(api)))
for (const file of makeProject(fresh()).filter(f => f.startsWith('src/services/'))) edit(api, file, text => text.replace('formatMoney(record.total)', 'formatMoney({ amount: record.total })'))
check('api-change: changed everywhere', task('api-change').check(api) === true, String(task('api-change').check(api)))

const repo = fresh({ history: true })
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
check('bisect: right answer', task('bisect').check(repo, historySubject(HISTORY.breaking)) === true, String(task('bisect').check(repo, historySubject(HISTORY.breaking))))
check('bisect: wrong answer', task('bisect').check(repo, historySubject(HISTORY.breaking - 1)) !== true)
check('bisect: no answer', task('bisect').check(repo, 'I could not tell') !== true)
check('the breaking commit is where the test starts to fail', (() => {
  const at = number => {
    git('checkout', '-q', `HEAD~${HISTORY.commits - number}`)
    const ok = runTests(repo).fail === 0
    git('checkout', '-q', 'main')
    return ok
  }
  return at(HISTORY.breaking - 1) === true && at(HISTORY.breaking) === false && at(1) === true
})())
git('checkout', '-q', 'HEAD~3')
check('bisect: right answer but left off main', task('bisect').check(repo, historySubject(HISTORY.breaking)) !== true, String(task('bisect').check(repo, historySubject(HISTORY.breaking))))

check('follow-chain: right answer', task('follow-chain').check(clean, `{"value": "${CHAIN.value}", "files": ${CHAIN.files}}`) === true)
check('follow-chain: wrong count', task('follow-chain').check(clean, `{"value": "${CHAIN.value}", "files": ${CHAIN.files - 1}}`) !== true)
check('follow-chain: a decoy value', task('follow-chain').check(clean, `{"value": "decoy-1", "files": ${CHAIN.files}}`) !== true)
check('the chain really has that many files', (() => {
  let file = 'config/chain/start.json'
  for (let count = 1; ; count++) {
    const data = JSON.parse(readFileSync(path.join(clean, file), 'utf8'))
    if (data.value !== undefined) return count === CHAIN.files && data.value === CHAIN.value
    file = data.next
  }
})())

for (const dir of [clean, bugs, move, feature, config, big, api, repo]) rmSync(dir, { recursive: true, force: true })
console.log(failed ? `${failed} checks failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
