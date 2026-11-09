import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { JsonlSessionBackend, sessionLockPath } from '../src/index.js'

/** When set, the next unlink of this path waits until the promise settles. */
const gate: { path?: string; open?: Promise<void> } = {}

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (gate.path !== undefined && path === gate.path && gate.open) {
        const open = gate.open
        delete gate.open
        await open
      }
      return actual.unlink(path)
    },
  }
})

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

it('keeps the lock file of a writer that arrives while the last one is still letting go', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-lock-handover-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  const backend = new JsonlSessionBackend(file)
  const first = {}
  const second = {}
  await backend.hold(first)
  // The release has read its own token and is about to remove the file when
  // the second writer arrives.
  gate.path = sessionLockPath(file)
  gate.open = new Promise(resolve => setTimeout(resolve, 50))
  const released = backend.release(first)
  await backend.hold(second)
  await released
  // The second writer holds the Session: its lock file must be on disk.
  expect(JSON.parse(await readFile(sessionLockPath(file), 'utf8'))).toMatchObject({ pid: process.pid })
  await backend.release(second)
  expect(existsSync(sessionLockPath(file))).toBe(false)
})
