// Shared pieces for the helper tests: a run object like the worker's, and a throwaway project folder.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGuard } from '../src/guard.mjs'

export function fakeRun(id = '1') {
  const controller = new AbortController()
  return {
    id,
    steps: [],
    notes: [],
    journal: new Map(),
    bytesIn: 0,
    children: new Set(),
    signal: controller.signal,
    abort: () => controller.abort(),
    note(list) {
      if (list?.length) this.notes.push(...list)
    },
    step(step) {
      this.steps.push(step)
    },
  }
}

/** A project folder with the given files ({ 'src/a.ts': 'text' }). */
export function project(files = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lever-test-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), text)
  }
  return dir
}

export function makeEnv(projectDir, { guards = [], run = fakeRun() } = {}) {
  const env = { projectDir, guard: createGuard({ projectDir, hooks: 'off', guards }), history: [], current: run }
  env.run = () => env.current
  return env
}
