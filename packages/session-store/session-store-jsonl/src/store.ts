import { stat } from 'node:fs/promises'
import type { Context } from '@tnega/core'
import { JsonlSessionBackend, SessionLockedError, SessionLog, SessionNotFoundError, type SessionBackend, type SessionEvent } from '@tnega/session'
import {
  SessionLeaseError,
  SessionStore,
  canonicalEvent,
  type CreateSessionOptions,
  type SessionAppendResult,
  type SessionLease,
  type SessionMetaPatch,
  type SessionSnapshot,
  type SessionSnapshotOptions,
  type SessionSummary,
} from '@tnega/session-store'
import {
  createSession,
  deleteSession,
  listSessions,
  patchSessionMeta,
  readSessionEventsReadOnly,
  readSessionSnapshot,
  readSessionSummary,
  sessionFile,
} from './index.js'

interface HeldLease {
  owner: string
  /** The lock file's owner in this process; the lease holds it while it lives. */
  holder: object
}

/**
 * `ctx.sessionStore` on this machine: one JSONL file per Session under
 * `~/.tnega`, the lock file next to it as the lease. Writers in other
 * processes are kept out by the lock file (taken over once nobody has
 * touched it for 30 seconds); writers in this process by the lease table.
 */
export class JsonlSessionStore extends SessionStore {
  private readonly leases = new Map<string, HeldLease>()
  /** Appends to one file run one at a time, so the head check and the write agree. */
  private readonly tails = new Map<string, Promise<unknown>>()

  create(workspace: string, options?: CreateSessionOptions): Promise<SessionSummary> {
    return createSession(workspace, options)
  }

  list(workspace: string): Promise<SessionSummary[]> {
    return listSessions(workspace)
  }

  summary(workspace: string, id: string): Promise<SessionSummary> {
    return readSessionSummary(workspace, id)
  }

  snapshot(workspace: string, id: string, options: SessionSnapshotOptions = {}): Promise<SessionSnapshot> {
    const { windowFor, ...page } = options
    return readSessionSnapshot(workspace, id, windowFor, page)
  }

  async *read(workspace: string, id: string, afterSeq = 0): AsyncIterable<SessionEvent> {
    const file = sessionFile(workspace, id)
    // A live writer in this process may still hold events in memory.
    await SessionLog.flushLive(file)
    if (!await stat(file).catch(() => undefined)) throw new SessionNotFoundError(file)
    for (const event of await readSessionEventsReadOnly(workspace, id)) {
      if (event.seq > afterSeq) yield event
    }
  }

  append(workspace: string, id: string, request: { expectedSeq: number; events: readonly SessionEvent[]; owner: string }): Promise<SessionAppendResult> {
    const file = sessionFile(workspace, id)
    const run = (this.tails.get(file) ?? Promise.resolve()).then(() => this.appendNow(workspace, id, file, request))
    const tail = run.catch(() => undefined)
    this.tails.set(file, tail)
    void tail.then(() => { if (this.tails.get(file) === tail) this.tails.delete(file) })
    return run
  }

  private async appendNow(
    workspace: string,
    id: string,
    file: string,
    { expectedSeq, events, owner }: { expectedSeq: number; events: readonly SessionEvent[]; owner: string },
  ): Promise<SessionAppendResult> {
    const lease = this.leases.get(file)
    if (lease?.owner !== owner) throw new SessionLeaseError(id, lease?.owner ?? 'nobody: take a lease before appending')
    const ids = new Set(events.map(event => event.id))
    if (ids.size !== events.length) throw new TypeError('append: a batch repeats an event id')

    if (!await stat(file).catch(() => undefined)) throw new SessionNotFoundError(file)
    const stored = await readSessionEventsReadOnly(workspace, id)
    const headSeq = stored.at(-1)?.seq ?? 0
    const byId = new Map(stored.map(event => [event.id, event] as const))
    const seen = events.map(event => byId.get(event.id))
    if (seen.length && seen.every(event => event !== undefined)) {
      // A retry: answer what was stored, if it is the same batch.
      const same = seen.every((event, index) => event !== undefined && canonicalEvent(event) === canonicalEvent(events[index]!))
      return same ? { status: 'committed', seqs: seen.map(event => event?.seq ?? 0) } : { status: 'conflict', headSeq }
    }
    if (seen.some(event => event !== undefined)) return { status: 'conflict', headSeq }
    if (headSeq !== expectedSeq) return { status: 'conflict', headSeq }
    events.forEach((event, index) => {
      if (event.seq !== expectedSeq + index + 1) throw new TypeError(`append: event ${event.id} has seq ${event.seq}, expected ${expectedSeq + index + 1}`)
    })
    const backend = new JsonlSessionBackend(file)
    await backend.append(events)
    await backend.sync()
    return { status: 'committed', seqs: events.map(event => event.seq) }
  }

  patchMeta(workspace: string, id: string, patch: SessionMetaPatch): Promise<SessionSummary> {
    return patchSessionMeta(workspace, id, patch)
  }

  async lease(workspace: string, id: string, owner: string): Promise<SessionLease> {
    const file = sessionFile(workspace, id)
    const current = this.leases.get(file)
    if (current && current.owner !== owner) throw new SessionLeaseError(id, current.owner)
    if (!current) {
      // A Session open for writing in this process writes past the store.
      if (SessionLog.live(file)) throw new SessionLeaseError(id, 'a running session in this process')
      const holder = {}
      try {
        await new JsonlSessionBackend(file).hold(holder)
      } catch (error) {
        if (error instanceof SessionLockedError) {
          throw new SessionLeaseError(id, `process ${error.holder.pid} on ${error.holder.host}`, { cause: error })
        }
        throw error
      }
      this.leases.set(file, { owner, holder })
    }
    return { owner, release: () => this.release(file, owner) }
  }

  private async release(file: string, owner: string): Promise<void> {
    const lease = this.leases.get(file)
    if (lease?.owner !== owner) return
    this.leases.delete(file)
    await new JsonlSessionBackend(file).release(lease.holder)
  }

  /** Let go of every lease this store holds. */
  async releaseAll(): Promise<void> {
    for (const [file, lease] of [...this.leases]) await this.release(file, lease.owner)
  }

  async delete(workspace: string, id: string): Promise<void> {
    const file = sessionFile(workspace, id)
    const lease = this.leases.get(file)
    if (lease) await this.release(file, lease.owner)
    await deleteSession(workspace, id)
  }

  backend(workspace: string, id: string): SessionBackend {
    return new JsonlSessionBackend(sessionFile(workspace, id))
  }
}

/** Mount: `await ctx.plugin(sessionStoreJsonl)`. Leases are released with the plugin. */
export const sessionStoreJsonl = {
  name: 'session-store-jsonl',
  apply(ctx: Context): void {
    const store = new JsonlSessionStore(ctx)
    ctx.fiber.effect(() => () => store.releaseAll(), 'session-store-jsonl/leases')
  },
}
