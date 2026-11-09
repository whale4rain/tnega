import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobStore } from '@tnega/blobs'
import type { Context } from '@tnega/core'
import { JsonlSessionBackend, SessionLockedError, SessionLog, SessionNotFoundError, type SessionBackend, type SessionEvent } from '@tnega/session'
import {
  BlobImagesBackend,
  SessionLeaseError,
  SessionStore,
  canonicalEvent,
  keepsImagesAsBlobs,
  restoreImages,
  storeImages,
  type CreateSessionOptions,
  type ForkSessionOptions,
  type SessionAppendResult,
  type SessionLease,
  type SessionMetaPatch,
  type SessionSearchHit,
  type SessionSnapshot,
  type SessionSnapshotOptions,
  type SessionSummary,
} from '@tnega/session-store'
import {
  createSession,
  deleteSession,
  ensureSessionDir,
  forkSession,
  isSessionId,
  listSessions,
  patchSessionMeta,
  readSessionEventsReadOnly,
  readSessionSnapshot,
  readSessionSummary,
  searchSessions,
  sessionFile,
  setSessionApprovalMode,
  setSessionPermission,
  truncateSessionAt,
} from './index.js'

interface HeldLease {
  owner: string
  /** The lock file's owner in this process; the lease holds it while it lives. */
  holder: object
  /** Settles once the lock file is taken; a second caller waits on it instead of taking another. */
  ready: Promise<void>
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
  /** Set once the plugin is disposed: a lease taken after would outlive it. */
  private closed = false
  /** Releases still letting go of their lock file; closing waits for them. */
  private readonly releasing = new Set<Promise<void>>()

  create(workspace: string, options?: CreateSessionOptions): Promise<SessionSummary> {
    return createSession(workspace, options)
  }

  async list(workspace: string): Promise<SessionSummary[]> {
    await this.flushLive(workspace)
    return listSessions(workspace)
  }

  /** A live writer in this process may still hold events in memory: listings and searches count them. */
  private async flushLive(workspace: string): Promise<void> {
    const dir = await ensureSessionDir(workspace)
    for (const entry of await readdir(dir).catch(() => [])) {
      if (entry.endsWith('.jsonl') && isSessionId(entry.slice(0, -'.jsonl'.length))) await SessionLog.flushLive(join(dir, entry))
    }
  }

  async summary(workspace: string, id: string): Promise<SessionSummary> {
    await SessionLog.flushLive(sessionFile(workspace, id))
    return readSessionSummary(workspace, id)
  }

  async search(workspace: string, query: string, options?: { limit?: number }): Promise<SessionSearchHit[]> {
    await this.flushLive(workspace)
    return searchSessions(workspace, query, options)
  }

  /**
   * Where image bytes go when this machine has `ctx.blobs` (format-11 logs).
   * Without it, images stay inline and a log that keeps them as blobs is read
   * without their bytes.
   */
  private get blobs(): BlobStore | undefined {
    return this.ctx.get('blobs')
  }

  async snapshot(workspace: string, id: string, options: SessionSnapshotOptions = {}): Promise<SessionSnapshot> {
    const { windowFor, ...page } = options
    const snapshot = await readSessionSnapshot(workspace, id, windowFor, page)
    const blobs = this.blobs
    if (!blobs) return snapshot
    const cache = new Map<string, Promise<string>>()
    return {
      ...snapshot,
      events: await restoreImages(snapshot.events, blobs, cache),
      surface: await restoreImages(snapshot.surface, blobs, cache),
      log: await restoreImages(snapshot.log, blobs, cache),
    }
  }

  async *read(workspace: string, id: string, afterSeq = 0): AsyncIterable<SessionEvent> {
    const file = sessionFile(workspace, id)
    // A live writer in this process may still hold events in memory.
    await SessionLog.flushLive(file)
    if (!await stat(file).catch(() => undefined)) throw new SessionNotFoundError(file)
    const events = (await readSessionEventsReadOnly(workspace, id)).filter(event => event.seq > afterSeq)
    const blobs = this.blobs
    yield* blobs ? await restoreImages(events, blobs) : events
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
    { expectedSeq, events: given, owner }: { expectedSeq: number; events: readonly SessionEvent[]; owner: string },
  ): Promise<SessionAppendResult> {
    const lease = this.leases.get(file)
    if (lease?.owner !== owner) throw new SessionLeaseError(id, lease?.owner ?? 'nobody: take a lease before appending')
    await this.held(id, lease)
    // Released while it was still being taken: this append has no lease any more.
    if (this.leases.get(file) !== lease) throw new SessionLeaseError(id, 'nobody: the lease was released')
    const ids = new Set(given.map(event => event.id))
    if (ids.size !== given.length) throw new TypeError('append: a batch repeats an event id')

    const backend = new JsonlSessionBackend(file)
    const loaded = await backend.load()
    if (!loaded) throw new SessionNotFoundError(file)
    // A torn last line (a crash mid-write) would swallow the next event: cut it first.
    if (loaded.damaged) await backend.repair([])
    const stored = loaded.events
    // Compared and stored as the log keeps them: a format-11 log keeps image bytes as blobs.
    const blobs = this.blobs
    const events = blobs && keepsImagesAsBlobs(stored) ? await storeImages(given, blobs) : given
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
    await backend.append(events)
    await backend.sync()
    return { status: 'committed', seqs: events.map(event => event.seq) }
  }

  async patchMeta(workspace: string, id: string, { permission, approvalMode, ...meta }: SessionMetaPatch): Promise<SessionSummary> {
    // A field already in force stores nothing, so a retried patch adds no events.
    const current = await this.summary(workspace, id)
    const changed: SessionMetaPatch = {}
    if (meta.title !== undefined && (meta.title.trim() || 'New session') !== current.title) changed.title = meta.title
    if (meta.agentType !== undefined && meta.agentType !== current.agentType) changed.agentType = meta.agentType
    if (meta.mode !== undefined && meta.mode !== current.mode) changed.mode = meta.mode
    if (meta.model !== undefined && meta.model !== current.model) changed.model = meta.model
    if (meta.reasoningEffort !== undefined && meta.reasoningEffort !== (current.reasoningEffort ?? 'default')) changed.reasoningEffort = meta.reasoningEffort
    let summary = await patchSessionMeta(workspace, id, changed)
    if (approvalMode !== undefined) summary = await setSessionApprovalMode(workspace, id, approvalMode)
    if (permission !== undefined) summary = await setSessionPermission(workspace, id, permission)
    return summary
  }

  fork(workspace: string, id: string, options?: ForkSessionOptions): Promise<SessionSummary> {
    return forkSession(workspace, id, options)
  }

  rewind(workspace: string, id: string, messageId: string): Promise<SessionSummary> {
    return truncateSessionAt(workspace, id, messageId)
  }

  async lease(workspace: string, id: string, owner: string): Promise<SessionLease> {
    const file = sessionFile(workspace, id)
    if (this.closed) throw new SessionLeaseError(id, 'nobody: the store is closed')
    const current = this.leases.get(file)
    if (current) {
      if (current.owner !== owner) throw new SessionLeaseError(id, current.owner)
      await this.held(id, current)
      return { owner, release: () => this.release(file, owner) }
    }
    // A Session open for writing in this process writes past the store.
    if (SessionLog.live(file)) throw new SessionLeaseError(id, 'a running session in this process')
    const holder = {}
    // In the table before the lock file is taken, so a second caller cannot take its own.
    const lease: HeldLease = { owner, holder, ready: new JsonlSessionBackend(file).hold(holder) }
    this.leases.set(file, lease)
    try {
      await this.held(id, lease)
    } catch (error) {
      if (this.leases.get(file) === lease) this.leases.delete(file)
      throw error
    }
    return { owner, release: () => this.release(file, owner) }
  }

  /** Wait until `lease` holds the lock file; another process holding it is a lease error. */
  private async held(id: string, lease: HeldLease): Promise<void> {
    try {
      await lease.ready
    } catch (error) {
      if (error instanceof SessionLockedError) {
        throw new SessionLeaseError(id, `process ${error.holder.pid} on ${error.holder.host}`, { cause: error })
      }
      throw error
    }
  }

  private release(file: string, owner: string): Promise<void> {
    const lease = this.leases.get(file)
    if (lease?.owner !== owner) return Promise.resolve()
    this.leases.delete(file)
    const done = this.letGo(file, lease)
    this.releasing.add(done)
    void done.then(() => this.releasing.delete(done), () => this.releasing.delete(done))
    return done
  }

  private async letGo(file: string, lease: HeldLease): Promise<void> {
    // A lease still being taken is let go once it is held; one that failed holds nothing.
    if (!await lease.ready.then(() => true, () => false)) return
    // An append already writing under this lease finishes before the lock file goes.
    await this.tails.get(file)
    await new JsonlSessionBackend(file).release(lease.holder)
  }

  /** Let go of every lease this store holds, and take no more. */
  async releaseAll(): Promise<void> {
    this.closed = true
    for (const [file, lease] of [...this.leases]) await this.release(file, lease.owner)
    // A release that started before closing still holds its lock file until it ends.
    await Promise.allSettled([...this.releasing])
  }

  async delete(workspace: string, id: string): Promise<void> {
    const file = sessionFile(workspace, id)
    const lease = this.leases.get(file)
    if (lease) await this.release(file, lease.owner)
    await deleteSession(workspace, id)
  }

  backend(workspace: string, id: string): SessionBackend {
    const file = new JsonlSessionBackend(sessionFile(workspace, id))
    const blobs = this.blobs
    return blobs ? new BlobImagesBackend(file, blobs) : file
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
