// Writes a small but realistic project for the stress benchmark: about 80 files with an import graph a few levels deep,
// one 800-line module, a test suite that runs in under two seconds, config files and a 4 MB log. Everything is
// generated from the tables below, so every copy is the same and the checkers in tasks.mjs can work out the right
// answers from the files themselves. Options plant the problems the tasks ask about:
//   bugs: three bugs in small modules, so exactly three tests fail
//   ruleBugs: two bugs far apart in the 800-line module, so exactly two tests fail
//   history: a git repository of 24 commits, one of which breaks a test that still fails at the last commit
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const cap = text => text[0].toUpperCase() + text.slice(1)

// name, plural, the helpers it uses, other services it imports, and one export nothing else mentions (or null)
const SERVICES = [
  { name: 'order', plural: 'orders', uses: ['ids', 'money', 'text'], needs: [], dead: null },
  { name: 'invoice', plural: 'invoices', uses: ['ids', 'money'], needs: ['orders'], dead: null },
  { name: 'customer', plural: 'customers', uses: ['ids', 'text'], needs: [], dead: null },
  { name: 'shipment', plural: 'shipping', uses: ['dates', 'text'], needs: [], dead: null },
  { name: 'stockItem', plural: 'inventory', uses: ['arrays', 'text'], needs: [], dead: 'restockAll' },
  { name: 'price', plural: 'pricing', uses: ['money', 'stats'], needs: ['taxes'], dead: null },
  { name: 'discount', plural: 'discounts', uses: ['money'], needs: ['pricing'], dead: null },
  { name: 'refund', plural: 'refunds', uses: ['ids', 'money'], needs: ['payments'], dead: null },
  { name: 'notification', plural: 'notifications', uses: ['dates', 'text'], needs: [], dead: null },
  { name: 'report', plural: 'reports', uses: ['dates', 'stats', 'arrays'], needs: ['orders'], dead: null },
  { name: 'searchEntry', plural: 'search', uses: ['text', 'arrays'], needs: ['customers'], dead: null },
  { name: 'product', plural: 'catalog', uses: ['text', 'money'], needs: ['inventory'], dead: null },
  { name: 'payment', plural: 'payments', uses: ['ids', 'money'], needs: ['audit'], dead: null },
  { name: 'taxRule', plural: 'taxes', uses: ['money', 'stats'], needs: [], dead: null },
  { name: 'auditEntry', plural: 'audit', uses: ['ids', 'text'], needs: [], dead: 'clearAudit' },
]

const ROUTES = [
  { name: 'order', services: ['orders', 'invoices'] },
  { name: 'customer', services: ['customers', 'search'] },
  { name: 'catalog', services: ['catalog', 'inventory', 'pricing'] },
  { name: 'refund', services: ['refunds'] },
  { name: 'report', services: ['reports'] },
  { name: 'health', services: [] },
]

/** The timeout each service should end up with in the "apply the config" task (the files all start at 3000). */
export const TIMEOUTS = Object.fromEntries(SERVICES.map((service, index) => [service.plural, 1500 + ((index * 733) % 4000)]))

const HELPER_IMPORTS = {
  ids: "import { nextId } from '../core/ids.mjs'",
  money: "import { addMoney, formatMoney } from '../core/money.mjs'",
  text: "import { slugify, titleCase } from '../utils/text.mjs'",
  dates: "import { addDays, daysBetween } from '../utils/dates.mjs'",
  arrays: "import { groupBy, uniq } from '../utils/arrays.mjs'",
  stats: "import { mean, median } from '../utils/stats.mjs'",
}

function serviceSource(service) {
  const { name, plural, uses, needs, dead } = service
  const Name = cap(name)
  const serviceByPlural = Object.fromEntries(SERVICES.map(s => [s.plural, s]))
  const lines = [`// ${cap(plural)}: an in-memory store with the rules for one ${name}.`]
  for (const helper of uses) lines.push(HELPER_IMPORTS[helper])
  for (const need of needs) lines.push(`import { list${cap(serviceByPlural[need].name)}s } from './${need}.mjs'`)
  lines.push('', 'export const timeoutMs = 3000', '', 'const store = new Map()', '')
  lines.push(`export function create${Name}(input) {`)
  lines.push(`  const id = ${uses.includes('ids') ? `nextId('${name.slice(0, 3)}')` : '`' + name.slice(0, 3) + '-${store.size + 1}`'}`)
  lines.push(`  const record = { id, ...input }`)
  if (uses.includes('text')) lines.push(`  record.slug = slugify(input.label ?? id)`, `  record.title = titleCase(input.label ?? '')`)
  if (uses.includes('money')) lines.push(`  record.total = addMoney(input.amount ?? 0, input.fee ?? 0)`)
  if (uses.includes('dates')) lines.push(`  record.dueAt = addDays(input.createdAt ?? 0, input.days ?? 0)`)
  lines.push(`  store.set(id, record)`, `  return record`, `}`, '')
  lines.push(`export function get${Name}(id) {`, `  return store.get(id) ?? null`, `}`, '')
  lines.push(`export function list${Name}s() {`, `  return [...store.values()]`, `}`, '')
  lines.push(`export function describe${Name}(id) {`, `  const record = store.get(id)`, `  if (!record) return '${name} not found'`)
  const parts = ['record.id']
  if (uses.includes('money')) parts.push('formatMoney(record.total)')
  if (uses.includes('dates')) parts.push('`${daysBetween(0, record.dueAt)} days`')
  if (uses.includes('arrays')) parts.push('uniq(Object.keys(groupBy([record], item => item.id))).join()')
  if (uses.includes('stats')) parts.push('String(mean([median([1, 2, 3]), 2]))')
  for (const need of needs) parts.push(`\`${need}: \${list${cap(serviceByPlural[need].name)}s().length}\``)
  lines.push(`  return [${parts.join(', ')}].join(' | ')`, `}`, '')
  lines.push(`export function reset${Name}s() {`, `  store.clear()`, `}`)
  if (dead) lines.push('', `export function ${dead}() {`, `  for (const record of store.values()) record.touched = true`, `  return store.size`, `}`)
  return `${lines.join('\n')}\n`
}

function serviceTest(service) {
  const { name, plural, uses } = service
  const Name = cap(name)
  const input = ["label: 'Hello world'"]
  if (uses.includes('money')) input.push('amount: 10.5', 'fee: 5.25')
  if (uses.includes('dates')) input.push('createdAt: 0', 'days: 3')
  const checks = []
  if (uses.includes('text')) checks.push("  assert.equal(record.slug, 'hello-world')", "  assert.equal(record.title, 'Hello World')")
  if (uses.includes('money')) checks.push('  assert.equal(record.total, 15.75)')
  if (uses.includes('dates')) checks.push('  assert.equal(record.dueAt, 3 * 86_400_000)')
  return `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { create${Name}, describe${Name}, get${Name}, list${Name}s, reset${Name}s, timeoutMs } from '../src/services/${plural}.mjs'

test('${plural}: create, get, list and describe', () => {
  reset${Name}s()
  const record = create${Name}({ ${input.join(', ')} })
${checks.join('\n')}
  assert.equal(get${Name}(record.id).id, record.id)
  assert.equal(list${Name}s().length, 1)
  assert.match(describe${Name}(record.id), new RegExp(record.id))
  assert.equal(describe${Name}('missing'), '${name} not found')
})

test('${plural}: the timeout is a positive number', () => {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0)
})
`
}

function routeSource(route) {
  const byPlural = Object.fromEntries(SERVICES.map(s => [s.plural, s]))
  const lines = [`// HTTP-style handlers for ${route.name}.`, "import { truncate } from '../utils/text.mjs'"]
  for (const plural of route.services) {
    const Name = cap(byPlural[plural].name)
    lines.push(`import { create${Name}, describe${Name}, get${Name} } from '../services/${plural}.mjs'`)
  }
  lines.push('', `export function ${route.name}Health() {`, `  return { ok: true, name: truncate('${route.name} routes are up', 40) }`, `}`)
  for (const plural of route.services) {
    const Name = cap(byPlural[plural].name)
    lines.push('', `export function post${Name}(body) {`, `  const record = create${Name}(body)`, `  return { status: 201, body: get${Name}(record.id), summary: describe${Name}(record.id) }`, `}`)
  }
  return `${lines.join('\n')}\n`
}

function routeTest() {
  const byPlural = Object.fromEntries(SERVICES.map(s => [s.plural, s]))
  const lines = ["import assert from 'node:assert/strict'", "import { test } from 'node:test'"]
  for (const route of ROUTES) {
    const names = [`${route.name}Health`, ...route.services.map(plural => `post${cap(byPlural[plural].name)}`)]
    lines.push(`import { ${names.join(', ')} } from '../src/api/${route.name}Routes.mjs'`)
  }
  lines.push('', "test('every route answers', () => {")
  for (const route of ROUTES) {
    lines.push(`  assert.equal(${route.name}Health().ok, true)`)
    for (const plural of route.services) lines.push(`  assert.equal(post${cap(byPlural[plural].name)}({ label: 'A b', amount: 1, fee: 1, createdAt: 0, days: 1 }).status, 201)`)
  }
  lines.push('})')
  return `${lines.join('\n')}\n`
}

/** Deterministic pseudo-random numbers, so the log is the same in every copy. */
function random(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function logText() {
  const next = random(20261124)
  const errorCodes = [['E_TIMEOUT', 412], ['E_DB_CONN', 311], ['E_RATE_LIMIT', 207], ['E_AUTH', 99], ['E_PARSE', 55], ['E_DISK', 21]]
  const kinds = []
  for (const [code, count] of errorCodes) for (let i = 0; i < count; i++) kinds.push(['ERROR', code])
  // warnings and info lines mention the same codes, so counting lines by code alone gives the wrong answer
  for (let i = 0; i < 9000; i++) kinds.push(['WARN', errorCodes[Math.floor(next() * errorCodes.length)][0]])
  while (kinds.length < 42_000) kinds.push(['INFO', 'OK'])
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[kinds[i], kinds[j]] = [kinds[j], kinds[i]]
  }
  const services = SERVICES.map(s => s.plural)
  const start = Date.UTC(2026, 10, 1)
  const lines = kinds.map(([level, code], index) => {
    const stamp = new Date(start + index * 1700 + Math.floor(next() * 900)).toISOString()
    const service = services[Math.floor(next() * services.length)]
    const request = Math.floor(next() * 1e9).toString(36)
    const text = level === 'ERROR' ? `code=${code} request failed after ${Math.floor(next() * 5000)} ms` : level === 'WARN' ? `retrying, last code=${code} attempt=${1 + Math.floor(next() * 3)}` : `code=${code} handled in ${Math.floor(next() * 300)} ms`
    return `${stamp} ${level} [${service}] req=${request} ${text}`
  })
  return `${lines.join('\n')}\n`
}

// ---- the 800-line module: sixty small rules in four families, each with its own numbers

const RULE_NOUNS = ['Quantity', 'Discount', 'Shipping', 'Weight', 'Rating', 'Stock', 'Margin', 'Refund', 'Credit', 'Points', 'Latency', 'Retries', 'Batch', 'Quota', 'Budget']

/** One entry per rule: its name, source text and the body of its test. */
function rules({ ruleBugs }) {
  const out = []
  RULE_NOUNS.forEach((noun, n) => {
    const lower = noun.toLowerCase()
    const min = n * 5
    const max = min + 50 + n * 10
    out.push({
      name: `clamp${noun}`,
      source: `/**
 * Keeps a ${lower} value inside the allowed range.
 * Values below ${min} become ${min}, and values above ${max} become ${max}.
 * Anything that is not a finite number counts as the lowest value.
 */
export function clamp${noun}(value) {
  if (!Number.isFinite(value)) return ${min}
  if (value < ${min}) return ${min}
  if (value > ${max}) return ${max}
  return value
}`,
      test: [`assert.equal(clamp${noun}(${min - 1}), ${min})`, `assert.equal(clamp${noun}(${max + 1}), ${max})`, `assert.equal(clamp${noun}(${min + 3}), ${min + 3})`, `assert.equal(clamp${noun}(NaN), ${min})`],
    })
    const t1 = 100 + n * 20
    const [t2, t3] = [t1 * 2, t1 * 5]
    const [r1, r2, r3] = [5 + n, 10 + n, 15 + n]
    const tierBug = ruleBugs && noun === 'Shipping'
    out.push({
      name: `tier${noun}`,
      source: `/**
 * The ${lower} tier for an amount, as a whole number of percent.
 * From ${t1} it is ${r1}, from ${t2} it is ${r2}, and from ${t3} it is ${r3}.
 * Below ${t1} there is no tier.
 */
export function tier${noun}(amount) {
  if (amount >= ${t3}) return ${r3}
  if (amount ${tierBug ? '>' : '>='} ${t2}) return ${r2}
  if (amount >= ${t1}) return ${r1}
  return 0
}`,
      test: [`assert.equal(tier${noun}(${t1 - 1}), 0)`, `assert.equal(tier${noun}(${t1}), ${r1})`, `assert.equal(tier${noun}(${t2}), ${r2})`, `assert.equal(tier${noun}(${t3}), ${r3})`],
    })
    const prefix = noun.slice(0, 3).toUpperCase()
    const width = 3 + (n % 4)
    out.push({
      name: `label${noun}`,
      source: `/**
 * A fixed-width label for a ${lower} value, for reports and logs.
 * The whole part is padded with zeros to ${width} digits; a minus sign goes in front of it.
 */
export function label${noun}(value, unit = 'u') {
  const sign = value < 0 ? '-' : ''
  const whole = Math.abs(Math.trunc(value))
  return \`${prefix}:\${sign}\${String(whole).padStart(${width}, '0')}\${unit}\`
}`,
      test: [`assert.equal(label${noun}(7), '${prefix}:${'7'.padStart(width, '0')}u')`, `assert.equal(label${noun}(-12.9, 'kg'), '${prefix}:-${'12'.padStart(width, '0')}kg')`],
    })
    const divisor = 2 + n
    const scoreBug = ruleBugs && noun === 'Margin'
    out.push({
      name: `score${noun}`,
      source: `/**
 * The ${lower} score of a list of items: each value times its weight, summed and divided by ${divisor}.
 * An item without a weight counts once. The result is rounded to two decimals.
 */
export function score${noun}(items) {
  let total = 0
  for (const item of items) total += (item.value ?? 0) * (item.weight ?? ${scoreBug ? 0 : 1})
  return Math.round((total / ${divisor}) * 100) / 100
}`,
      test: [`assert.equal(score${noun}([{ value: 10, weight: 2 }, { value: 4 }]), ${Math.round((24 / divisor) * 100) / 100})`, `assert.equal(score${noun}([]), 0)`],
    })
  })
  return out
}

function rulesSource(options) {
  return `// Business rules: sixty small pure functions. Each one stands alone, so they can be read and tested one at a time.\n\n${rules(options).map(rule => rule.source).join('\n\n')}\n`
}

function rulesTest() {
  const list = rules({ ruleBugs: false })
  const names = list.map(rule => rule.name)
  const imports = []
  for (let i = 0; i < names.length; i += 6) imports.push(`  ${names.slice(i, i + 6).join(', ')},`)
  const tests = list.map(rule => `test('${rule.name}', () => {\n${rule.test.map(line => `  ${line}`).join('\n')}\n})`)
  return `import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport {\n${imports.join('\n')}\n} from '../src/engine/rules.mjs'\n\n${tests.join('\n\n')}\n`
}

// ---- the tax table and its history

const TAX_REGIONS = { KR: 0.1, JP: 0.1, US: 0.07, DE: 0.19, FR: 0.2, GB: 0.2, CA: 0.05, AU: 0.1 }
export const HISTORY = { commits: 24, breaking: 15 }
export const historySubject = number => `change ${String(number).padStart(2, '0')}: update tax table`

/** The tax table as it is after `revision` changes. Each change moves one untested rate a little; the breaking one
 * also moves KR, which the test checks. Without a history the table is the first revision. */
function taxTable(revision) {
  const rates = { ...TAX_REGIONS }
  const moving = ['JP', 'US', 'FR', 'GB', 'CA', 'AU']
  for (let change = 2; change <= revision; change++) {
    const region = moving[change % moving.length]
    rates[region] = Math.round((rates[region] + 0.001) * 1000) / 1000
    if (change === HISTORY.breaking) rates.KR = 0.11
  }
  return `// Tax rates by region, as a share of the amount. Revision ${revision}.
export const TAX_RATES = {
${Object.entries(rates).map(([region, rate]) => `  ${region}: ${rate},`).join('\n')}
}

export function taxFor(region, amount) {
  const rate = TAX_RATES[region]
  if (rate === undefined) throw new Error(\`no tax rate for \${region}\`)
  return Math.round(amount * rate * 100) / 100
}
`
}

// ---- a chain of config files: each names the next one, the last one holds a value

export const CHAIN = { files: 15, value: 'harbor-42' }

function chainFiles() {
  const next = random(4217)
  const name = () => `config/chain/${Math.floor(next() * 36 ** 6).toString(36).padStart(6, '0')}.json`
  const files = {}
  const path = ['config/chain/start.json', ...Array.from({ length: CHAIN.files - 1 }, name)]
  path.forEach((file, index) => {
    files[file] = `${JSON.stringify(index === path.length - 1 ? { value: CHAIN.value } : { next: path[index + 1] }, null, 2)}\n`
  })
  // files nothing points to: they hold other values, so searching for "value" does not find the answer
  for (let i = 0; i < 8; i++) files[name()] = `${JSON.stringify(i % 2 ? { value: `decoy-${i}` } : { next: name() }, null, 2)}\n`
  return files
}

function git(dir, args, date) {
  const stamp = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...stamp } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** Turns the project into a git repository whose history changes the tax table once per commit. */
function writeHistory(dir) {
  git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q'])
  // nothing from the machine's own git setup runs here or signs these commits
  mkdirSync(path.join(dir, '.git', 'no-hooks'), { recursive: true })
  for (const [key, value] of [['core.hooksPath', '.git/no-hooks'], ['commit.gpgsign', 'false'], ['user.name', 'bench'], ['user.email', 'bench@example.com']]) git(dir, ['config', key, value])
  for (let revision = 1; revision <= HISTORY.commits; revision++) {
    writeFileSync(path.join(dir, 'src/core/tax-table.mjs'), taxTable(revision))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', historySubject(revision)], `2026-11-01T00:${String(revision).padStart(2, '0')}:00Z`)
  }
}

export function makeProject(dir, { bugs = false, ruleBugs = false, history = false } = {}) {
  const files = {}
  files['package.json'] = `${JSON.stringify({ name: 'shop-core', version: '1.4.0', type: 'module', private: true, scripts: { test: 'node --test "test/*.test.mjs"' } }, null, 2)}\n`
  files['README.md'] = '# shop-core\n\nIn-memory services for a small shop: orders, invoices, customers and the rest.\n\nRun the tests with `npm test`.\n'
  files['config/timeouts.json'] = `${JSON.stringify(TIMEOUTS, null, 2)}\n`
  files['logs/app.log'] = logText()

  files['src/core/clock.mjs'] = `// The one place that reads the time, so tests can fix it.
let fixed = null

export function setNow(value) {
  fixed = value
}

export function now() {
  return fixed ?? Date.now()
}

export function toISO(ms) {
  return new Date(ms).toISOString()
}
`
  files['src/core/ids.mjs'] = `import { now } from './clock.mjs'

let counter = 0

export function nextId(prefix) {
  counter += 1
  return \`\${prefix}-\${now().toString(36)}-\${counter}\`
}

export function resetIds() {
  counter = 0
}
`
  files['src/core/money.mjs'] = `// Amounts are plain numbers in the main currency unit, rounded to cents.
export function roundCents(amount) {
  return Math.${bugs ? 'floor' : 'round'}(amount * 100) / 100
}

export function addMoney(a, b) {
  return roundCents(a + b)
}

export function formatMoney(amount, currency = 'USD') {
  return \`\${currency} \${roundCents(amount).toFixed(2)}\`
}

export function percentOf(amount, percent) {
  return roundCents((amount * percent) / 100)
}
`
  files['src/core/errors.mjs'] = `export class AppError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function notFound(what) {
  return new AppError('E_NOT_FOUND', \`\${what} not found\`)
}

export function invalid(what) {
  return new AppError('E_INVALID', \`\${what} is not valid\`)
}
`
  files['src/utils/text.mjs'] = `export function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function truncate(text, max) {
  return text.length <= max ? text : \`\${text.slice(0, max${bugs ? '' : ' - 1'})}…\`
}

export function titleCase(text) {
  return text
    .split(' ')
    .map(word => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ')
}

export function padLeft(text, width, fill = ' ') {
  return String(text).padStart(width, fill)
}
`
  files['src/utils/arrays.mjs'] = `export function chunk(items, size) {
  const out = []
  for (let i = 0; i ${bugs ? '<= items.length - size' : '< items.length'}; i += size) out.push(items.slice(i, i + size))
  return out
}

export function uniq(items) {
  return [...new Set(items)]
}

export function groupBy(items, keyOf) {
  const groups = {}
  for (const item of items) (groups[keyOf(item)] ??= []).push(item)
  return groups
}

export function sumBy(items, valueOf) {
  return items.reduce((sum, item) => sum + valueOf(item), 0)
}
`
  files['src/utils/stats.mjs'] = `export function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

export function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
`
  files['src/utils/dates.mjs'] = `import { toISO } from '../core/clock.mjs'

const DAY = 86_400_000

export function addDays(ms, days) {
  return ms + days * DAY
}

export function daysBetween(from, to) {
  return Math.round((to - from) / DAY)
}

export function dayOf(ms) {
  return toISO(ms).slice(0, 10)
}

export function isWeekend(ms) {
  const day = new Date(ms).getUTCDay()
  return day === 0 || day === 6
}
`
  for (const service of SERVICES) {
    files[`src/services/${service.plural}.mjs`] = serviceSource(service)
    files[`test/${service.plural}.test.mjs`] = serviceTest(service)
  }
  for (const route of ROUTES) files[`src/api/${route.name}Routes.mjs`] = routeSource(route)
  files['src/index.mjs'] = `${[
    "export * from './core/clock.mjs'",
    "export * from './core/ids.mjs'",
    "export * from './core/money.mjs'",
    "export * from './core/errors.mjs'",
    "export * from './utils/text.mjs'",
    "export * from './utils/arrays.mjs'",
    "export * from './utils/stats.mjs'",
    "export * from './utils/dates.mjs'",
    ...ROUTES.map(route => `export * from './api/${route.name}Routes.mjs'`),
  ].join('\n')}\n`

  files['test/core.test.mjs'] = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { now, setNow, toISO } from '../src/core/clock.mjs'
import { AppError, notFound } from '../src/core/errors.mjs'
import { nextId, resetIds } from '../src/core/ids.mjs'
import { addMoney, formatMoney, roundCents } from '../src/core/money.mjs'

test('clock can be fixed', () => {
  setNow(1000)
  assert.equal(now(), 1000)
  assert.equal(toISO(0), '1970-01-01T00:00:00.000Z')
  setNow(null)
})

test('ids count up', () => {
  setNow(36)
  resetIds()
  assert.equal(nextId('x'), 'x-10-1')
  assert.equal(nextId('x'), 'x-10-2')
  setNow(null)
})

test('money rounds to the nearest cent', () => {
  assert.equal(roundCents(2.346), 2.35)
  assert.equal(roundCents(2.349), 2.35)
  assert.equal(addMoney(0.1, 0.2), 0.3)
  assert.equal(formatMoney(3), 'USD 3.00')
  assert.equal(formatMoney(3.5, 'EUR'), 'EUR 3.50')
})

test('errors carry a code', () => {
  const error = notFound('order')
  assert.ok(error instanceof AppError)
  assert.equal(error.code, 'E_NOT_FOUND')
})
`
  files['test/text.test.mjs'] = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slugify, titleCase, truncate } from '../src/utils/text.mjs'

test('slugify keeps letters and digits', () => {
  assert.equal(slugify('  Hello, World! 42 '), 'hello-world-42')
  assert.equal(slugify('---'), '')
})

test('truncate never returns more than max characters', () => {
  assert.equal(truncate('short', 10), 'short')
  assert.equal(truncate('a longer sentence', 8), 'a longe…')
  assert.equal(truncate('a longer sentence', 8).length, 8)
})

test('titleCase capitalises each word', () => {
  assert.equal(titleCase('the quick fox'), 'The Quick Fox')
})
`
  files['test/arrays.test.mjs'] = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunk, groupBy, uniq } from '../src/utils/arrays.mjs'

test('chunk keeps the last short group', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunk([], 3), [])
})

test('uniq and groupBy', () => {
  assert.deepEqual(uniq([1, 1, 2]), [1, 2])
  assert.deepEqual(groupBy(['a', 'bb', 'cc'], word => word.length), { 1: ['a'], 2: ['bb', 'cc'] })
})
`
  files['test/stats.test.mjs'] = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mean, median } from '../src/utils/stats.mjs'

test('mean and median', () => {
  assert.equal(mean([1, 2, 3, 6]), 3)
  assert.equal(mean([]), 0)
  assert.equal(median([5, 1, 3]), 3)
  assert.equal(median([4, 1, 3, 2]), 2.5)
})
`
  files['test/dates.test.mjs'] = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addDays, dayOf, daysBetween } from '../src/utils/dates.mjs'

test('days are added and counted', () => {
  assert.equal(addDays(0, 2), 172_800_000)
  assert.equal(daysBetween(0, 172_800_000), 2)
  assert.equal(dayOf(0), '1970-01-01')
})
`
  files['test/routes.test.mjs'] = routeTest()
  files['src/engine/rules.mjs'] = rulesSource({ ruleBugs })
  files['test/rules.test.mjs'] = rulesTest()
  files['src/core/tax-table.mjs'] = taxTable(1)
  files['test/tax.test.mjs'] = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TAX_RATES, taxFor } from '../src/core/tax-table.mjs'

test('tax for the main regions', () => {
  assert.equal(taxFor('KR', 100), 10)
  assert.equal(taxFor('DE', 100), 19)
  assert.ok(Object.keys(TAX_RATES).length >= 8)
  assert.throws(() => taxFor('XX', 1))
})
`
  Object.assign(files, chainFiles())

  for (const [file, text] of Object.entries(files)) {
    const full = path.join(dir, file)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  if (history) writeHistory(dir)
  return Object.keys(files).sort()
}
