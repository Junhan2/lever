// The real thing over stdio: start bin/lever.mjs and talk MCP to it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { project } from './support.mjs'

const BIN = fileURLToPath(new URL('../bin/lever.mjs', import.meta.url))

function connect(dir, env = {}) {
  const child = spawn(process.execPath, [BIN], { cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDECODE: '', LEVER_HOOKS: 'off', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map()
  const notes = []
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)(message)
      waiting.delete(message.id)
    } else notes.push(message)
  })
  let seq = 0
  const request = (method, params, id = ++seq) =>
    new Promise(resolve => {
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  const close = () =>
    new Promise(resolve => {
      if (child.exitCode !== null) return resolve()
      const force = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.on('exit', () => {
        clearTimeout(force)
        resolve()
      })
      child.stdin.end()
    })
  return { request, notify, close, notes, stderr: () => stderr }
}

/** Runs body with a connected client and always closes it, so a failed check cannot leave the server running. */
async function withClient(dir, env, body) {
  const client = connect(dir, env)
  try {
    await body(client)
  } finally {
    await client.close()
  }
  return client
}

test('initialize, tools/list and tools/call over stdio', async () => {
  const done = await withClient(project({ 'a.txt': 'alpha\n' }), {}, async client => {
  const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '9' } })
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(init.result.serverInfo.name, 'lever')
  assert.ok(init.result.instructions.length > 50)
  client.notify('notifications/initialized')
  const list = await client.request('tools/list', {})
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['run'])
  assert.ok(list.result.tools[0].description.length < 2200)
  assert.equal(list.result.tools[0]._meta['anthropic/alwaysLoad'], true)
  const call = await client.request('tools/call', { name: 'run', arguments: { code: "(await read('a.txt')).trim() + ' ' + (await $`echo beta`.text())" } })
  assert.equal(call.result.isError, false)
  assert.equal(call.result.content[0].text.split('\n---\n')[0], 'alpha beta')
  const bad = await client.request('tools/call', { name: 'run', arguments: { code: 'throw new Error("boom")' } })
  assert.equal(bad.result.isError, true)
  assert.match(bad.result.content[0].text, /^Error: boom/)
  assert.equal((await client.request('nope/nothing', {})).error.code, -32601)
  })
  assert.doesNotMatch(done.stderr(), /ExperimentalWarning/)
})

test('2026-07-28 clients: discover, _meta versions, cancellation, background for non-Claude clients', async () => {
  await withClient(project(), { LEVER_AUTO_BACKGROUND_MS: '1500' }, async client => {
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'codex-mcp-client', version: '1' } }
  const discover = await client.request('server/discover', { _meta: meta })
  assert.ok(discover.result.supportedVersions.includes('2026-07-28'))
  assert.equal(typeof discover.result.ttlMs, 'number')
  const wrong = await client.request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } })
  assert.equal(wrong.error.code, -32022)
  assert.ok(wrong.error.data.supported.includes('2025-11-25'))

  const early = await client.request('tools/call', { name: 'run', arguments: { code: "await sleep(2000); 'finished later'" }, _meta: meta })
  assert.match(early.result.content[0].text, /goes on in the background as job (\d+)/)
  const job = /job (\d+)/.exec(early.result.content[0].text)[1]
  const waited = await client.request('tools/call', { name: 'run', arguments: { code: `await jobs.wait(${job})` }, _meta: meta })
  assert.equal(waited.result.content[0].text.split('\n---\n')[0], 'finished later')

  const started = client.request('tools/call', { name: 'run', arguments: { code: 'await $`sleep 5`' }, _meta: meta }, 77)
  setTimeout(() => client.notify('notifications/cancelled', { requestId: 77, reason: 'user' }), 100)
  const outcome = await Promise.race([started.then(() => 'answered'), new Promise(resolve => setTimeout(resolve, 1500, 'no answer'))])
  assert.equal(outcome, 'no answer') // a cancelled request gets no response
  })
})

test('code that throws later, or drops a rejected promise, keeps the session; the reply says what was thrown', async () => {
  await withClient(project(), {}, async client => {
    await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '9' } })
    const run = async code => (await client.request('tools/call', { name: 'run', arguments: { code } })).result.content[0].text
    await run('state.kept = 7')
    assert.equal(await run("setTimeout(() => { throw new Error('late boom') }, 20); 'first'"), 'first')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.match(await run('state.kept'), /^7\n---\nnote: thrown outside the awaited code \(by a timer, an event, or a promise without await\): Error: late boom$/)
    assert.match(await run("Promise.reject(new Error('nobody waits')); 'second'"), /^second\n---\nnote: thrown outside the awaited code .*: Error: nobody waits$/)
    assert.equal(await run('state.kept'), '7')
  })
})

test('a loop that never yields is ended and the next run still works', async () => {
  await withClient(project(), { LEVER_TIMEOUT_MS: '400' }, async client => {
  await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '9' } })
  await client.request('tools/call', { name: 'run', arguments: { code: 'state.kept = 1' } })
  const stuck = await client.request('tools/call', { name: 'run', arguments: { code: 'await sleep(10); while (true) {}' } })
  assert.equal(stuck.result.isError, true)
  assert.match(stuck.result.content[0].text, /stopped after 400 ms; the code did not give control back/)
  const after = await client.request('tools/call', { name: 'run', arguments: { code: 'typeof state.kept' } })
  assert.equal(after.result.content[0].text, 'undefined') // a fresh thread, as the reply said
  })
})
