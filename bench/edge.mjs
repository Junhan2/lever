// Edge cases, without a model: starts the real server over stdio and feeds it the awkward inputs that model-written code
// produces sooner or later (huge output, late errors, stuck processes, parallel edits, odd files, odd patterns, broken
// MCP servers, malformed requests). After every case it checks that the server still answers. Run: npm run edge
//   node bench/edge.mjs [--lever /path/to/bin/lever.mjs] [--only name-part] [--json file]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const option = name => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined)
const BIN = path.resolve(option('lever') ?? path.join(ROOT, 'bin', 'lever.mjs'))
const ECHO = path.join(ROOT, 'test', 'fixtures', 'echo-server.mjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
/** The path of the file a reply says its whole text went to. */
const savedFile = text => /(?:full text|MB\)): ([^\]\s]+)/.exec(text)?.[1]

function connect(dir, env = {}, clientName = 'claude-code') {
  const child = spawn(process.execPath, [BIN], { cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDECODE: '', LEVER_HOOKS: 'off', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map()
  const stray = []
  let stderr = ''
  let seq = 0
  child.stderr.on('data', chunk => (stderr = (stderr + chunk).slice(-4000)))
  child.stdin.on('error', () => {})
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return stray.push(line)
    }
    if (waiting.has(message.id)) {
      waiting.get(message.id)(message)
      waiting.delete(message.id)
    } else stray.push(message)
  })
  const exited = new Promise(resolve => child.on('exit', resolve))
  const request = (method, params, id = ++seq) =>
    new Promise(resolve => {
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const client = {
    child,
    stray,
    exited,
    request,
    stderr: () => stderr,
    nextId: () => ++seq,
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    raw: line => child.stdin.write(`${line}\n`),
    /** Runs code; `hung` when no reply comes in time. */
    async call(code, extra = {}, timeoutMs = 60_000, id = ++seq) {
      const reply = await Promise.race([request('tools/call', { name: 'run', arguments: { code, ...extra } }, id), delay(timeoutMs).then(() => null)])
      if (!reply) return { hung: true, text: '', body: '', isError: true, id }
      const text = reply.result?.content?.[0]?.text ?? JSON.stringify(reply.error)
      return { text, body: text.split('\n---\n')[0], isError: reply.result?.isError ?? true, id }
    },
    async close() {
      if (child.exitCode === null) {
        child.stdin.end()
        await Promise.race([exited, delay(5000).then(() => child.kill('SIGKILL'))])
      }
    },
  }
  client.ready = request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: clientName, version: 'edge' } })
  return client
}

const running = marker => spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length
async function gone(marker, withinMs = 5000) {
  for (const end = Date.now() + withinMs; Date.now() < end; await delay(150)) if (running(marker) === 0) return true
  return running(marker) === 0
}

// Each case returns true, or a string that says what was wrong. `c` is the shared server, `t` the test context.
const CASES = [
  // ---- output size
  ['a 10 MB string comes back short, and the file keeps it', async (c, t) => {
    const r = await c.call("'x'.repeat(10_000_000)")
    const file = savedFile(r.text)
    if (r.text.length > 9000) return `reply is ${r.text.length} characters`
    if (!file || !existsSync(file)) return 'no file with the full text'
    return statSync(file).size === 10_000_000 || `the saved file is ${statSync(file).size} bytes`
  }],
  ['a 64 MB string does not fill the disk', async c => {
    const started = Date.now()
    const r = await c.call("'y'.repeat(64 * 1024 * 1024)")
    const file = savedFile(r.text)
    if (r.hung) return 'no reply'
    if (Date.now() - started > 8000) return `took ${Date.now() - started} ms`
    if (!file || !existsSync(file)) return 'no saved file'
    if (statSync(file).size > 17 * 1024 * 1024) return `the saved file is ${Math.round(statSync(file).size / 1024 / 1024)} MB`
    return /middle cut/.test(r.text) || 'the reply does not say the saved text lost its middle'
  }],
  ['30 MB of command output is bounded', async c => {
    const r = await c.call("const r = await $`head -c 30000000 /dev/zero | tr '\\\\0' a`; return { length: r.stdout.length, note: r.stderr.slice(-80) }")
    return (!r.isError && /length: \d+/.test(r.body) && Number(/length: (\d+)/.exec(r.body)[1]) <= 17 * 1024 * 1024 && /dropped/.test(r.body)) || r.text.slice(0, 200)
  }],
  ['200,000 log lines are cut, not kept', async c => {
    const r = await c.call("for (let i = 0; i < 200000; i++) console.log('line number', i); 'end'")
    return (r.text.length < 9500 && /line number 0/.test(r.text) && /end/.test(r.text)) || `reply is ${r.text.length} characters`
  }],
  ['odd values render: cycles, big numbers, maps, errors, buffers', async c => {
    const r = await c.call("const a = {}; a.self = a; ({ a, big: 12345678901234567890n, f() {}, s: Symbol('x'), m: new Map([[1, 2]]), set: new Set([1]), date: new Date(0), re: /x/g, err: new Error('e'), buf: Buffer.from('hi'), u8: new Uint8Array(3), nan: NaN, undef: undefined })")
    return (!r.isError && /Circular/.test(r.body) && /12345678901234567890n/.test(r.body) && /1970-01-01/.test(r.body)) || r.text.slice(0, 300)
  }],
  ['a 100,000-item list is shortened and says so', async c => {
    const r = await c.call('Array.from({ length: 100000 }, (_, i) => `item-${i}`)')
    return (r.text.length < 9500 && /more/.test(r.text) && /full text: /.test(r.text)) || `reply is ${r.text.length} characters: ${r.text.slice(-150)}`
  }],

  // ---- what model-written code did in the stress runs
  ['a result after a for block is returned', async c => {
    const r = await c.call('const out = []\nfor (const n of [1, 2, 3]) {\n  out.push(n * 2)\n}\n({ count: out.length, out })')
    return r.body === 'count: 3\nout: [2,4,6]' || r.text.slice(0, 200)
  }],
  ['the chain Bun and zx have works: cwd, env, quiet', async (c, t) => {
    mkdirSync(path.join(t.dir, 'chain'), { recursive: true })
    const r = await c.call("({ where: (await $`pwd`.cwd('chain').nothrow().text()).endsWith('/chain'), here: (await $`pwd`.cwd(process.cwd()).quiet().text()) === process.cwd(), x: await $`printf %s \"$LEVER_Y\"`.env({ LEVER_Y: 'y' }).text() })")
    return r.body === 'where: true\nhere: true\nx: y' || r.text.slice(0, 300)
  }],
  ['file text in a returned object comes back exactly, and edit takes it back', async (c, t) => {
    writeFileSync(path.join(t.dir, 'exact.mjs'), 'export function f(n) {\n  if (n > 2) {\n    return 1\n  }\n  return 0\n}\n')
    const shown = await c.call("({ n: 1, src: await read('exact.mjs') })")
    if (!shown.body.endsWith('==> src <==\nexport function f(n) {\n  if (n > 2) {\n    return 1\n  }\n  return 0\n}')) return shown.text.slice(0, 300)
    const r = await c.call("await edit('exact.mjs', '  if (n > 2) {\\n    return 1', '  if (n >= 2) {\\n    return 1'); (await read('exact.mjs')).split('\\n')[1]")
    return r.body === '  if (n >= 2) {' || r.text.slice(0, 300)
  }],
  ['text given with the wrong indentation is still edited, with a note', async (c, t) => {
    writeFileSync(path.join(t.dir, 'shift.mjs'), 'function tier(n) {\n  if (n > 2) return 1\n  return 0\n}\n')
    const r = await c.call("await edit('shift.mjs', '    if (n > 2) return 1', '    if (n >= 2) return 1'); await read('shift.mjs')")
    return (r.body.includes('\n  if (n >= 2) return 1\n') && /indented 2 spaces less than given/.test(r.text)) || r.text.slice(0, 300)
  }],
  ['exists without await is noticed', async c => {
    const r = await c.call("exists('nothing-here.txt') ? 'always' : 'never'")
    return (r.body === 'always' && /was called without await/.test(r.text)) || r.text.slice(0, 300)
  }],
  ['a variable named like a helper gets a hint', async c => {
    const r = await c.call("const ls = await ls('.')\nls.length")
    return (r.isError && /"ls" is a helper/.test(r.text)) || r.text.slice(0, 300)
  }],
  ['grep { files: true } results passed as matches name the mistake', async (c, t) => {
    writeFileSync(path.join(t.dir, 'names.txt'), 'needle\n')
    const r = await c.call("const hits = await grep('needle', { path: 'names.txt', files: true }); await read(hits[0].file)")
    return (r.isError && /read\(path\): the path must be a non-empty string, got undefined/.test(r.text)) || r.text.slice(0, 300)
  }],

  // ---- errors and the life of a run
  ['thrown strings and null are reported', async c => {
    const a = await c.call("throw 'plain text'")
    const b = await c.call('throw null')
    return (a.isError && /plain text/.test(a.text) && b.isError && b.text.length > 3) || `${a.text} / ${b.text}`
  }],
  ['a syntax error names its line', async c => {
    const r = await c.call('const a = 1\nconst = 2')
    return (r.isError && /SyntaxError/.test(r.text) && /line 2/.test(r.text)) || r.text
  }],
  ['an error thrown after the run ended does not break the session', async c => {
    await c.call('state.keep = 7')
    const first = await c.call("setTimeout(() => { throw new Error('late boom') }, 30); 'first'")
    await delay(300)
    const after = await c.call('state.keep')
    if (first.body !== 'first') return `first reply: ${first.text}`
    return after.body === '7' || `state after the late error: ${after.text.slice(0, 200)}`
  }],
  ['a late error is shown to the model in the next reply', async c => {
    await c.call("setTimeout(() => { throw new Error('late boom two') }, 30); 'first'")
    await delay(300)
    const after = await c.call("'next'")
    return /late boom two/.test(after.text) || `next reply: ${after.text.slice(0, 200)}`
  }],
  ['a promise that rejects with nobody waiting does not break the session', async c => {
    await c.call('state.keep = 8')
    const first = await c.call("Promise.reject(new Error('nobody waits')); 'ok'")
    await delay(200)
    const after = await c.call('state.keep')
    return (first.body === 'ok' && after.body === '8') || `${first.text.slice(0, 120)} / ${after.text.slice(0, 120)}`
  }],
  ['a failed command that was not awaited does not break the session', async c => {
    await c.call('state.keep = 9')
    const first = await c.call("$`exit 3`; 'moved on'")
    await delay(300)
    const after = await c.call('state.keep')
    return (first.body.startsWith('moved on') && after.body === '9') || `${first.text.slice(0, 160)} / ${after.text.slice(0, 120)}`
  }],
  ['process.exit is refused with a reason', async c => {
    const r = await c.call('process.exit(1)')
    return (r.isError && /not available/.test(r.text)) || r.text
  }],
  ['an endless loop is stopped and the session goes on', async c => {
    const r = await c.call('while (true) {}', { timeout: 1 }, 20_000)
    const after = await c.call('2 + 2')
    return (!r.hung && r.isError && after.body === '4') || `${r.text.slice(0, 160)} / ${after.text}`
  }],
  ['an endless loop after an await is stopped and the session goes on', async c => {
    const r = await c.call('await sleep(10); while (true) {}', { timeout: 1 }, 20_000)
    const after = await c.call('3 + 3')
    return (!r.hung && r.isError && after.body === '6') || `${r.text.slice(0, 160)} / ${after.text}`
  }],
  ['a promise that never settles is stopped at the time limit', async c => {
    const started = Date.now()
    const r = await c.call('await new Promise(() => {})', { timeout: 1 }, 20_000)
    return (!r.hung && r.isError && /1 s|1\.0 s|1000 ms/.test(r.text) && Date.now() - started < 6000) || r.text.slice(0, 200)
  }],
  ['endless recursion is reported', async c => {
    const r = await c.call('const f = () => f(); f()')
    return (r.isError && /RangeError|call stack/i.test(r.text)) || r.text.slice(0, 200)
  }],
  ['a variable from an earlier run points to state', async c => {
    await c.call('const found = [1, 2, 3]; found.length')
    const r = await c.call('found.length')
    return (r.isError && /state/.test(r.text)) || r.text.slice(0, 240)
  }],

  // ---- processes
  ['a command that ignores the stop signal is killed', async c => {
    const started = Date.now()
    const r = await c.call("await $`trap '' TERM; sleep 30.123`.timeout(500).nothrow(); 'back'", {}, 20_000)
    return (r.body.startsWith('back') && Date.now() - started < 6000 && (await gone('sleep 30.123'))) || `${r.text.slice(0, 120)} · running: ${running('sleep 30.123')}`
  }],
  ['cancelling a run ends the whole process tree', async c => {
    const id = c.nextId()
    const pending = c.call('await $`sleep 31.123 & sleep 32.123 & wait`', {}, 4000, id)
    await delay(500)
    if (running('sleep 31.123') === 0) return 'the commands never started'
    c.notify('notifications/cancelled', { requestId: id, reason: 'edge test' })
    const r = await pending
    return (r.hung && (await gone('sleep 31.123')) && (await gone('sleep 32.123'))) || `answered: ${!r.hung} · running: ${running('sleep 3[12].123')}`
  }],
  ['a command that reads the keyboard gets nothing and returns', async c => {
    const started = Date.now()
    const r = await c.call('(await $`cat`.text()).length', {}, 10_000)
    return (r.body === '0' && Date.now() - started < 3000) || r.text.slice(0, 120)
  }],
  ['every kind of value survives quoting', async c => {
    const r = await c.call(`const values = ['a b', "it's", 'say "hi"', 'new\\nline', '-n', '', '한글 ✓', '$HOME', '\`date\`', 'a;b|c&d', '*', '~', '#x', '\\\\'];
const out = []; for (const v of values) out.push((await $\`printf '%s' \${v}\`).stdout === v);
const list = (await $\`printf '%s|' \${['x y', 'z']}\`).stdout;
const num = (await $\`printf '%s' \${42}\`).stdout;
return { bad: values.filter((_, i) => !out[i]), list, num }`)
    return (!r.isError && /bad: \[\]/.test(r.body) && /list: x y\|z\|/.test(r.body) && /num: 42/.test(r.body)) || r.text.slice(0, 300)
  }],
  ['200 commands at once', async c => {
    const started = Date.now()
    const r = await c.call('const out = await Promise.all(Array.from({ length: 200 }, (_, i) => $`echo ${i}`.text())); out.every((v, i) => v === String(i))', {}, 60_000)
    return (r.body === 'true' && Date.now() - started < 30_000) || `${r.text.slice(0, 200)} in ${Date.now() - started} ms`
  }],
  ['a missing working folder is named in the error', async c => {
    const r = await c.call("await $({ cwd: 'no-such-folder' })`pwd`")
    return (r.isError && /no-such-folder/.test(r.text) && !/spawn \S+ ENOENT/.test(r.text)) || r.text.slice(0, 240)
  }],
  ['env and cwd options reach the command', async (c, t) => {
    mkdirSync(path.join(t.dir, 'sub'), { recursive: true })
    const r = await c.call("({ x: await $({ env: { LEVER_X: '42' } })`printf %s \"$LEVER_X\"`.text(), where: (await $({ cwd: 'sub' })`pwd`.text()).endsWith('/sub') })")
    return (/x: 42/.test(r.body) && /where: true/.test(r.body)) || r.text.slice(0, 200)
  }],
  ['bad JSON from a command says what it got', async c => {
    const r = await c.call('await $`echo not-json`.json()')
    return (r.isError && /JSON/.test(r.text) && /not-json/.test(r.text)) || r.text.slice(0, 240)
  }],
  ['a failed command shows both streams', async c => {
    const r = await c.call('await $`echo to-out; echo to-err >&2; exit 2`')
    return (r.isError && /to-out/.test(r.text) && /to-err/.test(r.text) && /exit 2/.test(r.text)) || r.text.slice(0, 240)
  }],
  ['text can be piped into a command', async c => {
    const r = await c.call("await $({ input: 'b\\na\\n' })`sort`.text()")
    return r.body === 'a\nb' || r.text.slice(0, 240)
  }],

  // ---- files
  ['2,000 files read at once', async (c, t) => {
    mkdirSync(path.join(t.dir, 'many'), { recursive: true })
    for (let i = 0; i < 2000; i++) writeFileSync(path.join(t.dir, 'many', `f${i}.txt`), `file ${i}\n`)
    const started = Date.now()
    const r = await c.call("const files = await glob('many/*.txt'); const texts = await Promise.all(files.map(f => read(f))); ({ files: files.length, chars: texts.join('').length })", {}, 60_000)
    return (/files: 2000/.test(r.body) && Date.now() - started < 15_000) || `${r.text.slice(0, 200)} in ${Date.now() - started} ms`
  }],
  ['edits to one file at the same time all land', async (c, t) => {
    writeFileSync(path.join(t.dir, 'same.txt'), 'a b c d e\n')
    const r = await c.call("await Promise.all([edit('same.txt', 'a', 'A'), edit('same.txt', 'c', 'C'), edit('same.txt', 'e', 'E')]); await read('same.txt')")
    return r.body.trim() === 'A b C d E' || `file is now: ${JSON.stringify(readFileSync(path.join(t.dir, 'same.txt'), 'utf8'))} · ${r.text.slice(0, 160)}`
  }],
  ['a write and an edit of one file at the same time keep order', async (c, t) => {
    const r = await c.call("await Promise.all([write('order.txt', 'one two'), edit('order.txt', 'one', '1').catch(e => e.message)]); await read('order.txt')")
    return /^(1 two|one two)$/.test(r.body.trim()) || r.text.slice(0, 200)
  }],
  ['replacement text with $ signs stays as written', async (c, t) => {
    writeFileSync(path.join(t.dir, 'dollar.txt'), 'X and X\n')
    const r = await c.call("await edit('dollar.txt', 'X', '$& $1 $$', { all: true }); await read('dollar.txt')")
    return r.body.trim() === '$& $1 $$ and $& $1 $$' || r.text.slice(0, 200)
  }],
  ['Windows line ends and a byte-order mark survive an edit', async (c, t) => {
    writeFileSync(path.join(t.dir, 'crlf.txt'), '﻿alpha\r\nbeta\r\n')
    await c.call("await edit('crlf.txt', 'beta', 'BETA')")
    const bytes = readFileSync(path.join(t.dir, 'crlf.txt'))
    return (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && bytes.toString('utf8').endsWith('alpha\r\nBETA\r\n')) || JSON.stringify(bytes.toString('utf8'))
  }],
  ['binary data round-trips', async c => {
    const r = await c.call("await write('bin.dat', Buffer.from([0, 255, 1, 254, 13, 10])); [...(await read('bin.dat', { encoding: 'buffer' }))].join(',')")
    return r.body === '0,255,1,254,13,10' || r.text.slice(0, 200)
  }],
  ['reading a folder says to list it', async c => {
    const r = await c.call("await read('.')")
    return (r.isError && /folder|directory/i.test(r.text) && /ls\(/.test(r.text)) || r.text.slice(0, 240)
  }],
  ['a missing file is named, with close matches', async (c, t) => {
    writeFileSync(path.join(t.dir, 'settings.json'), '{}')
    const r = await c.call("await read('setting.json')")
    return (r.isError && /setting\.json/.test(r.text) && /settings\.json/.test(r.text)) || r.text.slice(0, 240)
  }],
  ['a link that points to itself is reported', async (c, t) => {
    spawnSync('ln', ['-s', 'loop', 'loop'], { cwd: t.dir })
    const r = await c.call("await read('loop')")
    return (r.isError && r.text.length > 10) || r.text.slice(0, 200)
  }],
  ['a file name typed in another Unicode form is found', async (c, t) => {
    writeFileSync(path.join(t.dir, '한글노트.txt'.normalize('NFD')), 'ok\n')
    const r = await c.call(`(await read(${JSON.stringify('한글노트.txt'.normalize('NFC'))})).trim()`)
    return r.body === 'ok' || r.text.slice(0, 200)
  }],
  ['undo walks back run by run and skips files changed since', async (c, t) => {
    writeFileSync(path.join(t.dir, 'u1.txt'), 'one\n')
    writeFileSync(path.join(t.dir, 'u2.txt'), 'two\n')
    await c.call("await edit('u1.txt', 'one', 'ONE')")
    await c.call("await edit('u2.txt', 'two', 'TWO'); await write('u3.txt', 'new')")
    const first = await c.call('await undo()')
    const state1 = [readFileSync(path.join(t.dir, 'u1.txt'), 'utf8'), readFileSync(path.join(t.dir, 'u2.txt'), 'utf8'), existsSync(path.join(t.dir, 'u3.txt'))].join('|')
    writeFileSync(path.join(t.dir, 'u1.txt'), 'changed by someone else\n')
    const second = await c.call('await undo()')
    const state2 = readFileSync(path.join(t.dir, 'u1.txt'), 'utf8')
    return (state1 === 'ONE\n|two\n|false' && state2 === 'changed by someone else\n' && /skipped/.test(second.body) && /u1\.txt/.test(second.body)) || `${state1} / ${JSON.stringify(state2)} / ${first.body.slice(0, 80)} / ${second.body.slice(0, 120)}`
  }],

  // ---- search
  ['a JavaScript-only pattern (lookbehind) still searches', async (c, t) => {
    writeFileSync(path.join(t.dir, 'look.txt'), 'foobar\nbazbar\n')
    const r = await c.call("(await grep(/(?<=foo)bar/, { path: 'look.txt' })).map(m => m.line)")
    return r.body === '[1]' || r.text.slice(0, 300)
  }],
  ['a pattern with a backreference still searches', async (c, t) => {
    writeFileSync(path.join(t.dir, 'back.txt'), 'abab\nabcd\n')
    const r = await c.call("(await grep(/(ab)\\1/, { path: 'back.txt' })).map(m => m.line)")
    return r.body === '[1]' || r.text.slice(0, 300)
  }],
  ['text that is no regular expression is searched for as it is, and the reply says so', async (c, t) => {
    writeFileSync(path.join(t.dir, 'lit.txt'), 'call(a+b(c\n')
    const r = await c.call("(await grep('a+b(c', { path: 'lit.txt' })).map(m => m.line)")
    return (!r.isError && r.body === '[1]' && /searched for as plain text/.test(r.text)) || r.text.slice(0, 300)
  }],
  ['more matches than the limit are cut with a note', async (c, t) => {
    writeFileSync(path.join(t.dir, 'lots.txt'), Array.from({ length: 5000 }, (_, i) => `needle ${i}`).join('\n'))
    const r = await c.call("(await grep('needle', { path: 'lots.txt' })).length")
    return (r.body === '2000' && /stopped at 2000/.test(r.text)) || r.text.slice(0, 200)
  }],
  ['glob handles braces, spaces and a missing folder', async (c, t) => {
    mkdirSync(path.join(t.dir, 'g d'), { recursive: true })
    for (const name of ['g d/a b.txt', 'g d/c.md', 'g d/e.js']) writeFileSync(path.join(t.dir, name), 'x')
    const r = await c.call("({ both: await glob('g d/*.{txt,md}'), none: await glob('nowhere/**/*.js') })")
    return (/both: \["g d\/a b\.txt","g d\/c\.md"\]/.test(r.body) && /none: \[\]/.test(r.body)) || r.text.slice(0, 200)
  }],
  ['search gives the same files with and without ripgrep', async (c, t) => {
    for (const name of ['p/src/a.js', 'p/node_modules/x/b.js', 'p/.hidden/c.js', 'p/dist/d.js']) {
      mkdirSync(path.dirname(path.join(t.dir, name)), { recursive: true })
      writeFileSync(path.join(t.dir, name), 'findme\n')
    }
    writeFileSync(path.join(t.dir, 'p/.gitignore'), 'dist/\n')
    const code = "({ glob: await glob('p/**/*.js'), all: await glob('p/**/*.js', { all: true }), grep: await grep('findme', { path: 'p', files: true }) })"
    const withRg = await c.call(code)
    const plain = await t.fresh({ LEVER_RG: 'off' })
    const withoutRg = await plain.call(code)
    await plain.close()
    return (withRg.body === withoutRg.body && /glob: \["p\/src\/a\.js"\]/.test(withRg.body)) || `with ripgrep: ${withRg.body.replace(/\n/g, ' ')} · without: ${withoutRg.body.replace(/\n/g, ' ')}`
  }],

  // ---- jobs and several runs at once
  ['a background job can be waited for, and a failed one shows its error', async c => {
    const start = await c.call("await sleep(300); 'job result'", { background: true })
    const id = /job (\d+)/.exec(start.text)?.[1]
    const done = await c.call(`await jobs.wait(${id})`)
    const failing = await c.call("throw new Error('job broke')", { background: true })
    const failed = await c.call(`await jobs.wait(${/job (\d+)/.exec(failing.text)?.[1]})`)
    return (done.body === 'job result' && /job broke/.test(failed.text)) || `${start.text.slice(0, 100)} / ${done.text.slice(0, 100)} / ${failed.text.slice(0, 100)}`
  }],
  ['cancelling a job ends its commands', async c => {
    const start = await c.call('await $`sleep 33.123`', { background: true })
    const id = /job (\d+)/.exec(start.text)?.[1]
    await delay(400)
    await c.call(`jobs.cancel(${id})`)
    return (await gone('sleep 33.123')) || `still running: ${running('sleep 33.123')}`
  }],
  ['five runs at once keep their own logs and results', async c => {
    const replies = await Promise.all([1, 2, 3, 4, 5].map(k => c.call(`console.log('run ${k}'); await sleep(${100 + k * 30}); await $\`echo step-${k}\`; state.k${k} = ${k}; ${k}`)))
    const clean = replies.every((r, i) => r.body === `run ${i + 1}\n${i + 1}` && /1 sh/.test(r.text))
    const after = await c.call('[state.k1, state.k2, state.k3, state.k4, state.k5].join()')
    return (clean && after.body === '1,2,3,4,5') || replies.map(r => r.body.replace(/\n/g, '⏎')).join(' | ')
  }],
  ['a client with a short tool limit gets an early reply and the result later', async (c, t) => {
    const other = await t.fresh({ LEVER_AUTO_BACKGROUND_MS: '300' }, 'codex-mcp-client')
    const early = await other.call("await sleep(900); 'finished later'")
    const id = /job (\d+)/.exec(early.text)?.[1]
    // with a limit this short one wait cannot last; the reply says to ask again, as a model would
    let late = await other.call(`await jobs.wait(${id})`)
    for (let tries = 0; tries < 20 && /still running/.test(late.text); tries++) {
      await delay(150)
      late = await other.call(`await jobs.wait(${id})`)
    }
    await other.close()
    return (/background as job/.test(early.text) && late.body === 'finished later') || `${early.text.slice(0, 120)} / ${late.text.slice(0, 120)}`
  }],

  // ---- the protocol
  ['broken and unknown requests get error replies', async c => {
    const before = c.stray.length
    c.raw('this is not json')
    const unknown = await c.request('tools/call', { name: 'nope', arguments: {} })
    const missing = await c.request('tools/call', { name: 'run', arguments: {} })
    c.notify('notifications/cancelled', { requestId: 987654 })
    await delay(100)
    const parse = c.stray.slice(before).find(m => m?.error?.code === -32700)
    return (Boolean(parse) && unknown.error?.code === -32602 && missing.result?.isError === true) || JSON.stringify({ parse, unknown: unknown.error, missing: missing.result })
  }],
  ['1 MB of code runs', async c => {
    const r = await c.call(`/* ${'pad '.repeat(250_000)} */ 'big code ok'`)
    return r.body === 'big code ok' || r.text.slice(0, 120)
  }],
  ['closing the client ends running commands', async (c, t) => {
    const other = await t.fresh()
    other.call('await $`sleep 34.123`', {}, 2000)
    await delay(500)
    if (running('sleep 34.123') === 0) return 'the command never started'
    await other.close()
    return (await gone('sleep 34.123')) || `still running: ${running('sleep 34.123')}`
  }],

  // ---- other MCP servers
  ['an MCP tool call works, and a tool error is an error', async c => {
    const ok = await c.call("await mcp.echo.say({ text: 'over mcp' })")
    const bad = await c.call('await mcp.echo.fail({})')
    const none = await c.call('await mcp.nothere.x()')
    return (ok.body === 'over mcp' && bad.isError && none.isError && /echo/.test(none.text)) || `${ok.text.slice(0, 80)} / ${bad.text.slice(0, 80)} / ${none.text.slice(0, 120)}`
  }],
  ['an MCP server that dies mid-call gives an error, and the next call starts it again', async c => {
    const first = await c.call('await mcp.crash.boom({})', {}, 20_000)
    const second = await c.call('await mcp.crash.boom({})', {}, 20_000)
    const other = await c.call("await mcp.echo.say({ text: 'still here' })")
    return (!first.hung && first.isError && /crash/.test(first.text) && !second.hung && second.isError && other.body === 'still here') || `${first.text.slice(0, 160)} / ${second.text.slice(0, 160)} / ${other.text.slice(0, 80)}`
  }],
  ['an MCP server that prints noise before its replies still works', async c => {
    const r = await c.call("await mcp.noisy.say({ text: 'through the noise' })", {}, 20_000)
    return r.body === 'through the noise' || r.text.slice(0, 200)
  }],

  // ---- modules
  ['a project file imported again after an edit: the reply says import() gave the old copy, and a process runs the new one', async (c, t) => {
    writeFileSync(path.join(t.dir, 'helper.mjs'), 'export const value = 1\n')
    const first = await c.call("(await import('./helper.mjs')).value")
    await delay(20)
    await c.call("await edit('helper.mjs', 'value = 1', 'value = 2')")
    const second = await c.call("(await import('./helper.mjs')).value")
    const fresh = await c.call("await $`node -e \"import('./helper.mjs').then(m => console.log(m.value))\"`.text()")
    return (first.body === '1' && /helper\.mjs changed after this session first imported it/.test(second.text) && fresh.body === '2') || `first ${first.text.slice(0, 80)} · after the edit ${second.text.slice(0, 200)} · in a process ${fresh.text.slice(0, 80)}`
  }],
  ['import lines and Node modules work', async c => {
    const r = await c.call("import fs from 'node:fs'\nimport { basename } from 'node:path'\n({ here: fs.existsSync('.'), name: basename('/a/b.txt') })")
    return (/here: true/.test(r.body) && /name: b\.txt/.test(r.body)) || r.text.slice(0, 200)
  }],

  // ---- memory (last: it may cost the worker)
  ['running out of memory ends the run, not the server', async (c, t) => {
    const other = await t.fresh()
    const r = await other.call('const hog = []; for (;;) hog.push(new Array(1e6).fill(7))', { timeout: 60 }, 90_000)
    const after = await other.call('5 + 5', {}, 15_000)
    await other.close()
    return (!r.hung && r.isError && after.body === '10') || `reply: ${r.hung ? 'none' : r.text.slice(0, 160)} · after: ${after.hung ? 'none' : after.text.slice(0, 80)}`
  }],
]

const dir = mkdtempSync(path.join(os.tmpdir(), 'lever-edge-'))
const configFile = path.join(dir, 'lever-config.json')
writeFileSync(path.join(dir, 'crash-server.mjs'), "process.stdin.on('data', chunk => { for (const line of String(chunk).split('\\n').filter(Boolean)) { const m = JSON.parse(line); if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'crash', version: '1' } } })); else if (m.method === 'tools/call') { console.error('crash server: giving up'); process.exit(7) } else if (m.id !== undefined) console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } })) } })\n")
writeFileSync(path.join(dir, 'noisy-server.mjs'), `console.log('starting up, please wait...'); console.log('{ not json'); await import(${JSON.stringify(ECHO)})\n`)
writeFileSync(configFile, JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [ECHO] }, crash: { command: process.execPath, args: [path.join(dir, 'crash-server.mjs')] }, noisy: { command: process.execPath, args: [path.join(dir, 'noisy-server.mjs')] } } }))
const baseEnv = { LEVER_CONFIG: configFile, LEVER_MCP_IMPORT: 'none', LEVER_SPILL_DIR: path.join(dir, '.spill') }
const context = {
  dir,
  async fresh(env = {}, clientName) {
    const client = connect(dir, { ...baseEnv, ...env }, clientName)
    await client.ready
    return client
  },
}

const only = option('only')
const results = []
let server = await context.fresh()
for (const [name, run] of CASES.filter(([caseName]) => !only || caseName.includes(only))) {
  const started = Date.now()
  let verdict
  try {
    verdict = await Promise.race([run(server, context), delay(150_000).then(() => 'the case itself timed out')])
  } catch (error) {
    verdict = `the case threw: ${error.message}`
  }
  const alive = await server.call('1 + 1', {}, 10_000)
  if (alive.body !== '2') {
    verdict = `${verdict === true ? '' : `${verdict} · `}the server stopped answering afterwards (${alive.hung ? 'no reply' : alive.text.slice(0, 80)})`
    await server.close()
    server = await context.fresh()
  }
  results.push({ name, ok: verdict === true, detail: verdict === true ? '' : String(verdict), ms: Date.now() - started })
  console.log(`${verdict === true ? 'ok  ' : 'FAIL'} ${name}${verdict === true ? '' : `\n       ${String(verdict).slice(0, 500)}`}`)
}
await server.close()
for (const marker of ['sleep 30.123', 'sleep 31.123', 'sleep 32.123', 'sleep 33.123', 'sleep 34.123']) spawnSync('pkill', ['-f', marker])
rmSync(dir, { recursive: true, force: true })
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length} of ${results.length} edge cases pass`)
if (option('json')) writeFileSync(option('json'), JSON.stringify(results, null, 2))
process.exit(failed.length ? 1 : 0)
