import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { readFileSync, unlinkSync } from 'node:fs'
import { open, readFile, stat, unlink, utimes } from 'node:fs/promises'

/**
 * Another process is writing this Session. Two writers would interleave
 * appends and let one repair the other's live turn, so the second one stops.
 */
export class SessionLockedError extends Error {
  override name = 'SessionLockedError'
  constructor(readonly file: string, readonly holder: SessionLockHolder) {
    super(`session is being written by another process (pid ${holder.pid} on ${holder.host}): ${file}`)
  }
}

export interface SessionLockHolder {
  pid: number
  host: string
  token: string
}

/** The holder refreshes the lock this often; a lock untouched for {@link STALE_MS} is abandoned. */
const HEARTBEAT_MS = 5_000
const STALE_MS = 30_000

interface HeldLock {
  path: string
  token: string
  owners: Set<object>
  heartbeat: ReturnType<typeof setInterval>
}

const held = new Map<string, HeldLock>()
const acquiring = new Map<string, Promise<HeldLock>>()
const self = { pid: process.pid, host: hostname() }

let exitHook = false
function releaseAllOnExit(): void {
  if (exitHook) return
  exitHook = true
  process.once('exit', () => {
    for (const lock of held.values()) {
      clearInterval(lock.heartbeat)
      try {
        // Only remove a lock that is still ours.
        if (parseHolder(readFileSync(lock.path, 'utf8'))?.token === lock.token) unlinkSync(lock.path)
      } catch {
        // The process is exiting; a leftover lock goes stale on its own.
      }
    }
  })
}

export function sessionLockPath(file: string): string {
  return `${file}.lock`
}

function parseHolder(text: string): SessionLockHolder | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object') return undefined
    const { pid, host, token } = value as Record<string, unknown>
    return typeof pid === 'number' && typeof host === 'string' && typeof token === 'string'
      ? { pid, host, token }
      : undefined
  } catch {
    return undefined
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The live holder of another process, if any. A lock is abandoned when its
 * process is gone (same host) or when it has not been refreshed recently,
 * which also covers a lock file synced over from another machine.
 */
async function otherHolder(path: string): Promise<SessionLockHolder | undefined> {
  let text: string
  let modified: number
  try {
    [text, modified] = await Promise.all([readFile(path, 'utf8'), stat(path).then(info => info.mtimeMs)])
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const holder = parseHolder(text)
  if (!holder) return Date.now() - modified < STALE_MS ? { pid: 0, host: 'unknown', token: '' } : undefined
  if (holder.pid === self.pid && holder.host === self.host) return undefined
  if (Date.now() - modified >= STALE_MS) return undefined
  if (holder.host === self.host && !alive(holder.pid)) return undefined
  return holder
}

/** Who else is writing `file` right now, without taking the lock. */
export async function sessionLockHolder(file: string): Promise<SessionLockHolder | undefined> {
  if (held.has(file)) return undefined
  return otherHolder(sessionLockPath(file))
}

async function acquire(file: string): Promise<HeldLock> {
  const path = sessionLockPath(file)
  const token = randomUUID()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ ...self, token }), 'utf8')
      } finally {
        await handle.close()
      }
      const heartbeat = setInterval(() => {
        const now = new Date()
        void utimes(path, now, now).catch(() => undefined)
      }, HEARTBEAT_MS)
      heartbeat.unref?.()
      releaseAllOnExit()
      return { path, token, owners: new Set(), heartbeat }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const holder = await otherHolder(path)
    if (holder) throw new SessionLockedError(file, holder)
    // Abandoned by a crashed or long-gone writer: take it over.
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  const holder = await otherHolder(path)
  throw new SessionLockedError(file, holder ?? { pid: 0, host: 'unknown', token: '' })
}

/**
 * Register `owner` as a writer of `file`, taking the cross-process lock for
 * this process on the first one. Writers in the same process share it.
 */
export async function holdSessionLock(file: string, owner: object): Promise<void> {
  let lock = held.get(file)
  if (!lock) {
    let pending = acquiring.get(file)
    if (!pending) {
      pending = acquire(file)
      acquiring.set(file, pending)
      void pending.then(() => acquiring.delete(file), () => acquiring.delete(file))
    }
    lock = await pending
    held.set(file, lock)
  }
  lock.owners.add(owner)
}

/** Drop `owner`; the last writer in this process releases the lock. */
export async function releaseSessionLock(file: string, owner: object): Promise<void> {
  const lock = held.get(file)
  if (!lock || !lock.owners.delete(owner) || lock.owners.size) return
  held.delete(file)
  clearInterval(lock.heartbeat)
  try {
    if (parseHolder(await readFile(lock.path, 'utf8'))?.token === lock.token) await unlink(lock.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
