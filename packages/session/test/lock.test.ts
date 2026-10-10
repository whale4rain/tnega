import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionLockedError, SessionLog, sessionLockPath } from '../src/index.js'

const dirs: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-lock-'))
  dirs.push(dir)
  return join(dir, 'session.jsonl')
}

/** Another live process that claims the lock. */
async function foreignLock(file: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  await writeFile(sessionLockPath(file), JSON.stringify({ pid: child.pid, host: hostname(), token: 'other' }))
  return child
}

it('holds a lock while writing and releases it on close', async () => {
  const file = await tempFile()
  const log = new SessionLog(file)
  await log.append('user/message', { content: 'hi' })
  const holder = JSON.parse(await readFile(sessionLockPath(file), 'utf8'))
  expect(holder).toMatchObject({ pid: process.pid, host: hostname() })
  // A second writer in the same process shares it.
  const sibling = new SessionLog(file)
  await sibling.append('user/message', { content: 'again' })
  await sibling.close()
  expect(existsSync(sessionLockPath(file))).toBe(true)
  await log.close()
  expect(existsSync(sessionLockPath(file))).toBe(false)
})

it('refuses to write, and does not repair, a session another process is writing', async () => {
  const file = await tempFile()
  const prior = new SessionLog(file)
  await prior.append('turn/start', { turn: 1, input: 'go', reason: 'user' })
  await prior.close()
  const child = await foreignLock(file)

  const reader = new SessionLog(file)
  await reader.init()
  // The other process's turn is live: no closing events were written.
  expect((await reader.read()).map(event => event.type)).toEqual(['meta', 'turn/start'])
  await expect(reader.append('user/message', { content: 'clash' })).rejects.toBeInstanceOf(SessionLockedError)
  await reader.close()

  child.kill()
  await new Promise(resolve => child.once('exit', resolve))
  // Its process is gone, so the lock is abandoned and the log is repaired.
  const after = new SessionLog(file)
  await after.init()
  expect((await after.read()).at(-1)?.type).toBe('turn/end')
  await after.append('user/message', { content: 'mine now' })
  await after.close()
})

it('takes over a lock nobody has refreshed for a while', async () => {
  const file = await tempFile()
  await foreignLock(file)
  const old = new Date(Date.now() - 60_000)
  await utimes(sessionLockPath(file), old, old)
  const log = new SessionLog(file)
  await log.append('user/message', { content: 'hi' })
  expect(JSON.parse(await readFile(sessionLockPath(file), 'utf8'))).toMatchObject({ pid: process.pid })
  await log.close()
})
