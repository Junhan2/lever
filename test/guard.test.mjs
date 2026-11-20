import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// Keep the real user settings (and their rules and hooks) out of these tests.
process.env.CLAUDE_CONFIG_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'lever-home-'))
import { createGuard, matcherMatches, readPreHook } from '../src/guard.mjs'

test('matchers follow the hooks reference', () => {
  assert.equal(matcherMatches('*', 'Bash'), true)
  assert.equal(matcherMatches('', 'Read'), true)
  assert.equal(matcherMatches('Bash', 'Bash'), true)
  assert.equal(matcherMatches('Edit|Write', 'Write'), true)
  assert.equal(matcherMatches('Edit, Write', 'MultiEdit'), false) // exact names, not substrings
  assert.equal(matcherMatches('Bash|Edit|Write|MultiEdit|mcp__.*', 'mcp__lever__run'), true) // regex path
  assert.equal(matcherMatches('Edit.*', 'NotebookEdit'), true) // unanchored
  assert.equal(matcherMatches('^Edit$', 'NotebookEdit'), false)
})

test('hook outputs: exit 2, deny, ask, context, legacy decision', () => {
  assert.equal(readPreHook({ code: 2, stdout: '', stderr: 'no\n' }).deny, 'no')
  const deny = readPreHook({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'r' } }), stderr: '' })
  assert.equal(deny.deny, 'r')
  assert.match(readPreHook({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask' } }), stderr: '' }).deny, /approve/)
  assert.equal(readPreHook({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'careful' } }), stderr: '' }).note, 'careful')
  assert.equal(readPreHook({ code: 0, stdout: JSON.stringify({ decision: 'block', reason: 'old' }), stderr: '' }).deny, 'old')
  assert.deepEqual(readPreHook({ code: 1, stdout: 'not json', stderr: 'oops' }), {})
})

function project(settings) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lever-guard-'))
  mkdirSync(path.join(dir, '.claude'))
  writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings))
  return dir
}

test('runs project hooks with the documented input and honours a deny', async () => {
  const hook = "python3 -c \"import json,sys; d=json.load(sys.stdin); c=d['tool_input'].get('command',''); print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny' if 'rm -rf' in c else 'allow', 'permissionDecisionReason': 'no rm', 'additionalContext': d['tool_name'] + ' seen'}}))\""
  const dir = project({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hook }] }] } })
  const guard = createGuard({ projectDir: dir, hooks: 'on' })
  const ok = await guard.before('Bash', { command: 'ls' })
  assert.equal(ok.deny, undefined)
  assert.deepEqual(ok.notes, ['Bash seen'])
  const refused = await guard.before('Bash', { command: 'rm -rf /tmp/x' })
  assert.equal(refused.deny, 'no rm')
  const other = await guard.before('Read', { file_path: '/etc/hosts' })
  assert.equal(other.deny, undefined) // matcher Bash does not fire for Read
})

test('hooks are off unless asked for, and guard modules run first', async () => {
  const dir = project({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'exit 2' }] }] } })
  const off = createGuard({ projectDir: dir, hooks: 'off' })
  assert.equal((await off.before('Bash', { command: 'ls' })).deny, undefined)
  const guardFile = path.join(dir, 'guard.mjs')
  writeFileSync(guardFile, "export default step => step.tool === 'Read' && step.input.file_path.includes('secret') ? 'kept away' : { note: 'checked ' + step.tool }")
  const withModule = createGuard({ projectDir: dir, hooks: 'off', guards: [guardFile] })
  assert.equal((await withModule.before('Read', { file_path: '/x/secret.txt' })).deny, 'kept away')
  assert.deepEqual((await withModule.before('Bash', { command: 'ls' })).notes, ['checked Bash'])
})
