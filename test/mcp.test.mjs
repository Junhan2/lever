import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createMcp, expandVars, serverList } from '../src/helpers/mcp.mjs'
import { createSession } from '../src/session.mjs'
import { project } from './support.mjs'

const ECHO = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url))

test('${VAR} and ${VAR:-default} expand like Claude Code does', () => {
  process.env.LEVER_TEST_VAR = 'set'
  assert.equal(expandVars('a-${LEVER_TEST_VAR}-${LEVER_TEST_MISSING:-dflt}-${LEVER_TEST_MISSING}'), 'a-set-dflt-${LEVER_TEST_MISSING}')
})

test('project .mcp.json servers need Claude Code approval; lever itself is never listed', () => {
  const dir = project({ '.mcp.json': JSON.stringify({ mcpServers: { approved: { command: 'x' }, pending: { command: 'y' }, lever: { command: 'lever' } } }) })
  const home = path.join(dir, 'home')
  mkdirSync(home)
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['approved'] }))
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const list = serverList({ projectDir: dir, mcpImport: ['claude', 'project'], mcpServers: { mine: { command: 'z' } } })
    assert.equal(list.approved.source, '.mcp.json')
    assert.match(list.pending.skipped, /not approved/)
    assert.equal(list.mine.source, 'lever config')
    assert.equal(list.lever, undefined)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  }
})

test('code calls another MCP server: text, JSON, images, errors, guards', async () => {
  const dir = project({ 'guard.mjs': "export default step => step.tool === 'mcp__echo__say' && step.input.text === 'forbidden' ? 'not that word' : null" })
  const config = {
    projectDir: dir,
    hooks: 'off',
    guards: [path.join(dir, 'guard.mjs')],
    maxOutput: 8000,
    timeoutMs: 60_000,
    spillDir: path.join(os.tmpdir(), `lever-mcp-test-${process.pid}`),
    mcpImport: [],
    mcpServers: { echo: { command: process.execPath, args: [ECHO] } },
  }
  const session = createSession(config, { mcp: env => createMcp(env, config) })
  try {
    assert.equal((await session.run('1', "await mcp.echo.say({ text: 'hi', loud: true })")).text.split('\n---\n')[0], 'HI')
    assert.equal((await session.run('2', "(await mcp.call('echo', 'json')).items.length")).text.split('\n---\n')[0], '3')
    const tools = await session.run('3', "(await mcp.tools('echo')).find(t => t.name === 'say')")
    assert.match(tools.text, /description: Says the text back\.\nparams: text\*: string, loud: boolean/)
    const shot = await session.run('4', 'await mcp.echo.shot()')
    const file = /image: (\S+)/.exec(shot.text)[1]
    assert.ok(existsSync(file) && file.endsWith('.png'))
    const failed = await session.run('5', 'await mcp.echo.fail()')
    assert.equal(failed.isError, true)
    assert.match(failed.text, /McpError: echo\.fail failed: it broke/)
    const refused = await session.run('6', "await mcp.echo.say({ text: 'forbidden' })")
    assert.match(refused.text, /Refused echo\.say: not that word/)
    const missing = await session.run('7', 'await mcp.nothere.tool()')
    assert.match(missing.text, /No MCP server named "nothere"\. Known: echo/)
    const pending = session.run('8', 'await mcp.echo.slow()')
    setTimeout(() => session.stop('8', 'test stop'), 100)
    assert.match((await pending).text, /^Stopped: test stop/)
    assert.equal((await session.run('9', 'mcp.servers()')).text, '(1 items)\n{"name":"echo","source":"lever config","type":"stdio","running":true}')
  } finally {
    await session.close()
  }
})
