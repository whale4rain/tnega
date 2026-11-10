import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { BlobStore } from '@tnega/blobs'
import type { Context } from '@tnega/core'
import {
  SESSION_FORMAT_VERSION,
  SessionLockedError,
  SessionLog,
  SessionNotFoundError,
  foldSessionMeta,
  isSessionEvent,
  type SessionBackend,
  type SessionEvent,
  type SessionLoad,
  type SessionLockHolder,
} from '@tnega/session'
import {
  BlobImagesBackend,
  ImageCache,
  SUMMARY_EVENT_TYPES,
  SessionLeaseError,
  SessionStore,
  canonicalEvent,
  changedMeta,
  forkBody,
  isSessionId,
  keepsImagesAsBlobs,
  metaPatchPayload,
  restoreImages,
  searchSnippet,
  snapshotFromFolds,
  storeImages,
  summaryFromEvents,
  trimStreams,
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
import { bool, int, json, optionalText, text, type SqlClient, type SqlQueryable } from './sql.js'
import { localWorkspaces, type WorkspaceResolver, type WorkspaceRow } from './workspaces.js'

export interface PgSessionStoreOptions {
  sql: SqlClient
  /** How a `WorkspaceKey` names a workspace row. Default: {@link localWorkspaces}. */
  workspaces?: WorkspaceResolver
  /** A lease nobody renewed for this long can be taken over. Default 30 s, as the local lock file. */
  leaseMs?: number
  /** How often a held lease is renewed. Default 5 s. */
  renewMs?: number
}

/** The writers of this process: a lease they hold whose process is gone can be taken at once. */
const PROCESS_INSTANCE = randomUUID()
const OWNER_PREFIX = 'tnega/'

interface OwnerParts { host: string; pid: number; instance: string }

/** `tnega/<host>/<pid>/<process instance>/<store>`: who holds a lease, readable by every server. */
function ownerParts(owner: string): OwnerParts | undefined {
  if (!owner.startsWith(OWNER_PREFIX)) return undefined
  const [host, pid, instance] = owner.slice(OWNER_PREFIX.length).split('/')
  const number = Number(pid)
  if (!host || !instance || !Number.isSafeInteger(number)) return undefined
  return { host, pid: number, instance }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/**
 * Whether `owner` is a writer of this machine that no longer runs: the same
 * pid in an earlier process (a restarted container reuses pids), or a pid
 * that has exited. Only then is a lease taken before it expires; a writer on
 * another machine keeps it until nobody renewed it for the lease time.
 */
function ownerGone(owner: string): boolean {
  const parts = ownerParts(owner)
  if (!parts || parts.host !== hostname()) return false
  if (parts.pid === process.pid) return parts.instance !== PROCESS_INSTANCE
  return !processAlive(parts.pid)
}

function lockHolder(owner: string): SessionLockHolder {
  const parts = ownerParts(owner)
  return parts ? { pid: parts.pid, host: parts.host, token: owner } : { pid: 0, host: owner, token: owner }
}

function holderName(owner: string): string {
  const parts = ownerParts(owner)
  return parts ? `process ${parts.pid} on ${parts.host}` : owner
}

/** Postgres refuses `\u0000` in `jsonb` text: a NUL in a tool's output is kept as U+FFFD. */
function withoutNul(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replaceAll('\u0000', '�') : value
  if (Array.isArray(value)) return value.map(withoutNul)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutNul(item)]))
  }
  return value
}

/** The event as the database can keep it. */
function storable(event: SessionEvent): SessionEvent {
  if (!JSON.stringify(event).includes('\\u0000')) return event
  const kept = withoutNul(event)
  if (!isSessionEvent(kept)) throw new TypeError(`event ${event.id} cannot be stored`)
  return kept
}

function contentHash(event: SessionEvent): string {
  return createHash('sha256').update(canonicalEvent(event)).digest('hex')
}

function eventOf(row: unknown, column = 'event'): SessionEvent {
  const value = json(row, column)
  if (!isSessionEvent(value)) throw new TypeError('a stored session event is not one')
  return value
}

function eventsOf(value: unknown): SessionEvent[] {
  if (!Array.isArray(value)) throw new TypeError('expected an array of session events')
  return value.map(item => {
    if (!isSessionEvent(item)) throw new TypeError('a stored session event is not one')
    return item
  })
}

interface SessionRow {
  head: number
  leaseOwner: string | undefined
  leased: boolean
}

interface Held {
  workspace: string
  owner: string
  /** `lease`: taken through {@link SessionStore.lease}; `log`: a `SessionLog` of this process writes. */
  kind: 'lease' | 'log'
  /** The logs writing under a `log` hold; the last one to let go releases it. */
  holders: Set<object>
  ready: Promise<void>
}

class LeaseTaken extends Error {
  constructor(readonly holder: string) {
    super(`lease held by ${holder}`)
  }
}

const SESSION_COLUMNS = `s.id::text as id,
  floor(extract(epoch from s.updated_at) * 1000)::float8 as updated_at,
  (select count(*)::int from session_event c where c.session_id = s.id) as event_count,
  coalesce((select json_agg(e.event order by e.seq) from session_event e where e.session_id = s.id and e.type = any($2::text[])), '[]'::json) as meta_events`

/**
 * `ctx.sessionStore` on Postgres (`docs/plans/v2-server-mvp.md` §3.2–3.3):
 * one `session` row per Session and one `session_event` row per event, the
 * whole event as `jsonb`. A batch is appended in one transaction that checks
 * the head and the lease, so two servers on one database cannot interleave;
 * the lease is the row's `lease_owner` / `lease_until`, renewed every five
 * seconds and free to take once nobody renewed it for thirty.
 */
export class PgSessionStore extends SessionStore {
  private readonly sql: SqlClient
  private readonly resolve: WorkspaceResolver
  private readonly leaseMs: number
  private readonly renewMs: number
  /** This store's part of every lease owner it writes, so two stores in one process stay apart. */
  private readonly storeId = randomUUID()
  private readonly workspaceRows = new Map<string, WorkspaceRow>()
  private readonly held = new Map<string, Held>()
  private renewTimer: ReturnType<typeof setInterval> | undefined
  private closed = false
  /** Sessions this store handed a backend for: a live writer may still hold their events in memory. */
  private readonly opened = new Map<string, { workspace: string; backend: SessionBackend }>()
  private readonly images = new ImageCache()

  constructor(ctx: Context, options: PgSessionStoreOptions) {
    super(ctx)
    this.sql = options.sql
    this.resolve = options.workspaces ?? localWorkspaces
    this.leaseMs = options.leaseMs ?? 30_000
    this.renewMs = options.renewMs ?? 5_000
  }

  private get blobs(): BlobStore | undefined {
    return this.ctx.get('blobs')
  }

  /** The owner a `SessionLog` of this process writes as. */
  private get processOwner(): string {
    return `${OWNER_PREFIX}${hostname()}/${process.pid}/${PROCESS_INSTANCE}/${this.storeId}`
  }

  private async workspaceRow(tx: SqlQueryable, key: string, create: boolean): Promise<WorkspaceRow | undefined> {
    const cached = this.workspaceRows.get(key)
    if (cached) return cached
    const row = await this.resolve(tx, key, create)
    if (row) this.workspaceRows.set(key, row)
    return row
  }

  private keyOf(id: string): string {
    return `postgres/sessions/${id}`
  }

  private checkId(id: string): void {
    if (!isSessionId(id)) throw new TypeError(`invalid session id: ${id}`)
  }

  private async sessionRow(tx: SqlQueryable, workspace: string, id: string, lock: boolean): Promise<SessionRow | undefined> {
    const row = await this.workspaceRow(tx, workspace, false)
    if (!row) return undefined
    const { rows } = await tx.query(
      `select head_seq::int as head, lease_owner, coalesce(lease_until > now(), false) as leased
       from session where id = $1 and workspace_id = $2${lock ? ' for update' : ''}`,
      [id, row.id],
    )
    const found = rows[0]
    if (found === undefined) return undefined
    return { head: int(found, 'head'), leaseOwner: optionalText(found, 'lease_owner'), leased: bool(found, 'leased') }
  }

  private async requireRow(tx: SqlQueryable, workspace: string, id: string, lock: boolean): Promise<SessionRow> {
    const row = await this.sessionRow(tx, workspace, id, lock)
    if (!row) throw new SessionNotFoundError(this.keyOf(id))
    return row
  }

  private async flushLive(workspace?: string): Promise<void> {
    for (const opened of this.opened.values()) {
      if (workspace === undefined || opened.workspace === workspace) await SessionLog.flushLive(opened.backend)
    }
  }

  private summaryFromRow(workspace: string, row: unknown): SessionSummary {
    const events = eventsOf(json(row, 'meta_events'))
    return summaryFromEvents(workspace, text(row, 'id'), events, int(row, 'event_count'), int(row, 'updated_at'))
  }

  private async readSummary(tx: SqlQueryable, workspace: string, id: string): Promise<SessionSummary | undefined> {
    const row = await this.workspaceRow(tx, workspace, false)
    if (!row) return undefined
    const { rows } = await tx.query(
      `select ${SESSION_COLUMNS} from session s where s.id = $1 and s.workspace_id = $3`,
      [id, SUMMARY_EVENT_TYPES, row.id],
    )
    const found = rows[0]
    return found === undefined ? undefined : this.summaryFromRow(workspace, found)
  }

  /** Keep the row's folded `meta` (for SQL readers) in step with the log. */
  private async refreshMeta(tx: SqlQueryable, workspace: string, id: string): Promise<void> {
    const summary = await this.readSummary(tx, workspace, id)
    if (summary) await tx.query(`update session set meta = $2::jsonb where id = $1`, [id, JSON.stringify(summary)])
  }

  private async insertEvents(tx: SqlQueryable, id: string, events: readonly SessionEvent[]): Promise<void> {
    if (!events.length) return
    await tx.query(
      `insert into session_event (session_id, event, content_hash)
       select $1, t.e::jsonb, decode(t.h, 'hex') from unnest($2::text[], $3::text[]) as t(e, h)`,
      [id, events.map(event => JSON.stringify(event)), events.map(contentHash)],
    )
  }

  /** The events that decide how this log keeps images. */
  private async formatEvents(tx: SqlQueryable, id: string): Promise<SessionEvent[]> {
    const { rows } = await tx.query(`select event from session_event where session_id = $1 and type = 'meta' order by seq`, [id])
    return rows.map(row => eventOf(row))
  }

  async create(workspace: string, options: CreateSessionOptions = {}): Promise<SessionSummary> {
    const id = randomUUID()
    const createdAt = options.createdAt ?? Date.now()
    const payload: Record<string, unknown> = {
      title: options.title?.trim() || 'New session',
      workspace,
      createdAt,
      formatVersion: SESSION_FORMAT_VERSION,
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.forkedAtMessageId ? { forkedAtMessageId: options.forkedAtMessageId } : {}),
      ...(options.agentType ? { agentType: options.agentType } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    }
    const meta: SessionEvent = { id, seq: 1, ts: createdAt, type: 'meta', payload }
    const summary = summaryFromEvents(workspace, id, [meta], 1, createdAt)
    await this.sql.transaction(async tx => {
      await this.insertSession(tx, workspace, id, meta, summary, createdAt)
    })
    return summary
  }

  private async insertSession(
    tx: SqlQueryable, workspace: string, id: string, first: SessionEvent, summary: SessionSummary, createdAt: number,
  ): Promise<void> {
    const row = await this.workspaceRow(tx, workspace, true)
    if (!row) throw new Error(`workspace ${workspace} has no row and could not get one`)
    await tx.query(
      `insert into session (id, workspace_id, account_id, meta, head_seq, created_at, updated_at)
       values ($1, $2, $3, $4::jsonb, $5, to_timestamp($6::float8 / 1000), to_timestamp($6::float8 / 1000))`,
      [id, row.id, row.accountId, JSON.stringify(summary), first.seq, createdAt],
    )
    await this.insertEvents(tx, id, [storable(first)])
  }

  async list(workspace: string): Promise<SessionSummary[]> {
    await this.flushLive(workspace)
    const row = await this.workspaceRow(this.sql, workspace, false)
    if (!row) return []
    const { rows } = await this.sql.query(
      `select ${SESSION_COLUMNS} from session s where s.workspace_id = $1 order by s.updated_at desc`,
      [row.id, SUMMARY_EVENT_TYPES],
    )
    return rows.map(found => this.summaryFromRow(workspace, found))
  }

  async summary(workspace: string, id: string): Promise<SessionSummary> {
    this.checkId(id)
    await this.flushLive(workspace)
    // A missing Session reads as an empty one, as the local store answers.
    return await this.readSummary(this.sql, workspace, id) ?? summaryFromEvents(workspace, id, [], 0, Date.now())
  }

  async search(workspace: string, query: string, options: { limit?: number } = {}): Promise<SessionSearchHit[]> {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    await this.flushLive(workspace)
    const row = await this.workspaceRow(this.sql, workspace, false)
    if (!row) return []
    const { rows } = await this.sql.query(
      `select distinct on (e.session_id) e.session_id::text as id, e.event
       from session_event e join session s on s.id = e.session_id
       where s.workspace_id = $1 and e.type in ('user/message', 'assistant/message')
         and strpos(lower(e.event->'payload'->>'content'), $2) > 0
       order by e.session_id, e.seq desc`,
      [row.id, needle],
    )
    const hits: Array<SessionSearchHit & { at: number }> = []
    for (const found of rows) {
      const event = eventOf(found)
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
      const snippet = searchSnippet(event.payload.content, needle)
      if (snippet !== undefined) hits.push({ id: text(found, 'id'), snippet, at: event.ts })
    }
    return hits.sort((a, b) => b.at - a.at).slice(0, options.limit ?? 50).map(({ id, snippet }) => ({ id, snippet }))
  }

  /** Run `work` on the live writer of this process, or on a log opened for it. */
  private async withLog<T>(workspace: string, id: string, work: (log: SessionLog) => Promise<T>, write = false): Promise<T> {
    const backend = this.backend(workspace, id)
    const live = SessionLog.live(backend)
    if (live) return work(live)
    const log = write ? new SessionLog(backend) : SessionLog.readOnly(backend)
    await log.init()
    try {
      return await work(log)
    } finally {
      await log.close()
    }
  }

  async snapshot(workspace: string, id: string, options: SessionSnapshotOptions = {}): Promise<SessionSnapshot> {
    this.checkId(id)
    const { windowFor, ...page } = options
    await this.flushLive(workspace)
    const summary = await this.readSummary(this.sql, workspace, id)
    if (!summary) throw new SessionNotFoundError(this.keyOf(id))
    const folds = await this.withLog(workspace, id, async log => ({
      log: trimStreams(await log.read()),
      surface: trimStreams(await log.surfaceEvents()),
      messages: await log.deriveMessages(),
    }))
    return snapshotFromFolds(workspace, id, folds, summary.updatedAt, windowFor, page)
  }

  async *read(workspace: string, id: string, afterSeq = 0): AsyncIterable<SessionEvent> {
    this.checkId(id)
    await this.flushLive(workspace)
    if (!await this.sessionRow(this.sql, workspace, id, false)) throw new SessionNotFoundError(this.keyOf(id))
    const { rows } = await this.sql.query(
      `select event from session_event where session_id = $1 and seq > $2 order by seq`,
      [id, afterSeq],
    )
    const events = rows.map(row => eventOf(row))
    const blobs = this.blobs
    yield* blobs ? await restoreImages(events, blobs, this.images) : events
  }

  append(workspace: string, id: string, request: { expectedSeq: number; events: readonly SessionEvent[]; owner: string }): Promise<SessionAppendResult> {
    this.checkId(id)
    return this.commit(workspace, id, request.expectedSeq, request.events, request.owner, (holder) => new SessionLeaseError(id, holder))
  }

  /**
   * §3.3 in one transaction: the row is locked, the lease and the head are
   * checked, a retried batch is answered from what is stored, and the events
   * go in with the head moved past them, or nothing does.
   */
  private async commit(
    workspace: string,
    id: string,
    expectedSeq: number,
    given: readonly SessionEvent[],
    owner: string,
    leaseError: (holder: string) => Error,
  ): Promise<SessionAppendResult> {
    const ids = new Set(given.map(event => event.id))
    if (ids.size !== given.length) throw new TypeError('append: a batch repeats an event id')
    return this.sql.transaction(async tx => {
      const row = await this.requireRow(tx, workspace, id, true)
      if (row.leaseOwner !== owner || !row.leased) {
        throw leaseError(row.leaseOwner && row.leased ? holderName(row.leaseOwner) : 'nobody: take a lease before appending')
      }
      const blobs = this.blobs
      const asStored = blobs && keepsImagesAsBlobs(await this.formatEvents(tx, id)) ? await storeImages(given, blobs) : given
      const events = asStored.map(storable)
      if (!events.length) return { status: 'committed', seqs: [] }
      const { rows } = await tx.query(
        `select event_id, seq::int as seq, encode(content_hash, 'hex') as hash from session_event where session_id = $1 and event_id = any($2::text[])`,
        [id, events.map(event => event.id)],
      )
      const stored = new Map(rows.map(found => [text(found, 'event_id'), { seq: int(found, 'seq'), hash: text(found, 'hash') }] as const))
      if (stored.size === events.length) {
        // A retry: answer what was stored, if it is the same batch.
        const same = events.every(event => stored.get(event.id)?.hash === contentHash(event))
        return same ? { status: 'committed', seqs: events.map(event => stored.get(event.id)?.seq ?? 0) } : { status: 'conflict', headSeq: row.head }
      }
      if (stored.size > 0 || row.head !== expectedSeq) return { status: 'conflict', headSeq: row.head }
      events.forEach((event, index) => {
        if (event.seq !== expectedSeq + index + 1) throw new TypeError(`append: event ${event.id} has seq ${event.seq}, expected ${expectedSeq + index + 1}`)
      })
      await this.insertEvents(tx, id, events)
      const head = expectedSeq + events.length
      await tx.query(`update session set head_seq = $2, updated_at = now() where id = $1`, [id, head])
      if (events.some(event => SUMMARY_EVENT_TYPES.includes(event.type))) await this.refreshMeta(tx, workspace, id)
      // NOTIFY payloads are small: other servers read the events themselves.
      await tx.query(`select pg_notify('session_events', $1)`, [`${id}:${head}`])
      return { status: 'committed', seqs: events.map(event => event.seq) }
    })
  }

  async patchMeta(workspace: string, id: string, { permission, approvalMode, ...meta }: SessionMetaPatch): Promise<SessionSummary> {
    const current = await this.summary(workspace, id)
    if (current.eventCount === 0) throw new SessionNotFoundError(this.keyOf(id))
    const payload = metaPatchPayload(changedMeta(current, meta))
    const setApproval = approvalMode !== undefined && approvalMode !== current.approvalMode
    const setPermission = permission !== undefined && permission !== current.permission
    if (payload || setApproval || setPermission) {
      await this.withLog(workspace, id, async log => {
        if (payload) await log.append('meta/patch', payload)
        if (setApproval) await log.append('meta', { kind: 'approval/mode', mode: approvalMode })
        if (setPermission) await log.append('permission/mode', { mode: permission })
        await log.flush()
      }, true)
    }
    return this.summary(workspace, id)
  }

  async fork(workspace: string, id: string, options: ForkSessionOptions = {}): Promise<SessionSummary> {
    this.checkId(id)
    if (!await this.sessionRow(this.sql, workspace, id, false)) throw new SessionNotFoundError(this.keyOf(id))
    const { all, events } = await this.withLog(workspace, id, async log => {
      const all = await log.read()
      return { all, events: options.messageId ? await log.forkAt(options.messageId) : all }
    })
    const head = all.find(event => event.type === 'meta')
    const createdAt: unknown = head ? Reflect.get(head.payload, 'createdAt') : undefined
    // The fork's head carries the source's current metadata, folded over the whole source.
    const folded = foldSessionMeta(all)
    const fork = await this.create(workspace, {
      title: options.title?.trim() || `${folded.title ?? 'New session'} fork`,
      ...(typeof createdAt === 'number' ? { createdAt } : {}),
      parentSessionId: id,
      ...(folded.agentType ? { agentType: folded.agentType } : {}),
      ...(folded.mode ? { mode: folded.mode } : {}),
      ...(folded.model ? { model: folded.model } : {}),
      ...(folded.reasoningEffort ? { reasoningEffort: folded.reasoningEffort } : {}),
      ...(options.messageId ? { forkedAtMessageId: options.messageId } : {}),
    })
    const blobs = this.blobs
    // Copied with their seqs, as the local store copies them; the fork is format 11.
    const body = (blobs ? await storeImages(forkBody(events), blobs) : forkBody(events)).map(storable)
    if (body.length) {
      await this.sql.transaction(async tx => {
        await this.insertEvents(tx, fork.id, body)
        await tx.query(
          `update session set head_seq = (select max(seq) from session_event where session_id = $1), updated_at = now() where id = $1`,
          [fork.id],
        )
        await this.refreshMeta(tx, workspace, fork.id)
      })
    }
    return this.summary(workspace, fork.id)
  }

  async rewind(workspace: string, id: string, messageId: string): Promise<SessionSummary> {
    this.checkId(id)
    await this.flushLive(workspace)
    await this.sql.transaction(async tx => {
      await this.requireRow(tx, workspace, id, true)
      const { rows } = await tx.query(
        `select seq::int as seq from session_event where session_id = $1 and event_id = $2 and type = 'user/message'`,
        [id, messageId],
      )
      const target = rows[0]
      if (target === undefined) throw new TypeError(`user message not found: ${messageId}`)
      // Every event before the message stays where it is, so seqs stay in order.
      await tx.query(`delete from session_event where session_id = $1 and seq >= $2`, [id, int(target, 'seq')])
      await tx.query(
        `update session set head_seq = coalesce((select max(seq) from session_event where session_id = $1), 0), updated_at = now() where id = $1`,
        [id],
      )
      await this.refreshMeta(tx, workspace, id)
    })
    return this.summary(workspace, id)
  }

  /**
   * Take the row's lease for `owner`, or throw {@link LeaseTaken}. A lease
   * already this owner's is renewed; one nobody renewed, or whose writer on
   * this machine is gone, is taken over.
   */
  private async takeLease(workspace: string, id: string, owner: string): Promise<void> {
    await this.sql.transaction(async tx => {
      const row = await this.requireRow(tx, workspace, id, true)
      if (row.leaseOwner && row.leaseOwner !== owner && row.leased && !ownerGone(row.leaseOwner)) throw new LeaseTaken(row.leaseOwner)
      await tx.query(
        `update session set lease_owner = $2, lease_until = now() + $3::int * interval '1 millisecond' where id = $1`,
        [id, owner, this.leaseMs],
      )
    })
  }

  private async dropLease(id: string, owner: string): Promise<void> {
    await this.sql.query(`update session set lease_owner = null, lease_until = null where id = $1 and lease_owner = $2`, [id, owner])
  }

  private startRenewing(): void {
    if (this.renewTimer || this.held.size === 0) return
    this.renewTimer = setInterval(() => void this.renew(), this.renewMs)
    this.renewTimer.unref?.()
  }

  private stopRenewing(): void {
    if (this.held.size > 0 || !this.renewTimer) return
    clearInterval(this.renewTimer)
    this.renewTimer = undefined
  }

  /** Renew every lease this store holds; one another writer took is dropped, and its appends will fail. */
  private async renew(): Promise<void> {
    for (const [id, held] of [...this.held]) {
      if (!await held.ready.then(() => true, () => false)) continue
      try {
        const { rows } = await this.sql.query(
          `update session set lease_until = now() + $3::int * interval '1 millisecond' where id = $1 and lease_owner = $2 returning id`,
          [id, held.owner, this.leaseMs],
        )
        if (rows.length === 0 && this.held.get(id) === held) this.held.delete(id)
      } catch {
        // The database is unreachable: try again next time; appends fail meanwhile if the lease lapses.
      }
    }
    this.stopRenewing()
  }

  async lease(workspace: string, id: string, owner: string): Promise<SessionLease> {
    this.checkId(id)
    if (this.closed) throw new SessionLeaseError(id, 'nobody: the store is closed')
    const current = this.held.get(id)
    if (current) {
      if (current.kind !== 'lease' || current.owner !== owner) {
        throw new SessionLeaseError(id, current.kind === 'log' ? 'a running session in this process' : current.owner)
      }
      await current.ready
      return { owner, release: () => this.release(id, owner) }
    }
    const held: Held = { workspace, owner, kind: 'lease', holders: new Set(), ready: this.takeLease(workspace, id, owner) }
    this.held.set(id, held)
    try {
      await held.ready
    } catch (error) {
      if (this.held.get(id) === held) this.held.delete(id)
      if (error instanceof LeaseTaken) throw new SessionLeaseError(id, holderName(error.holder), { cause: error })
      throw error
    }
    this.startRenewing()
    return { owner, release: () => this.release(id, owner) }
  }

  private async release(id: string, owner: string): Promise<void> {
    const held = this.held.get(id)
    if (held?.kind !== 'lease' || held.owner !== owner) return
    this.held.delete(id)
    this.stopRenewing()
    if (await held.ready.then(() => true, () => false)) await this.dropLease(id, owner)
  }

  /** A `SessionLog` of this process becomes a writer; logs on one Session share one lease. */
  private async holdForLog(workspace: string, id: string, log: object): Promise<void> {
    const current = this.held.get(id)
    if (current?.kind === 'log') {
      current.holders.add(log)
      try {
        await current.ready
      } catch (error) {
        current.holders.delete(log)
        throw error
      }
      return
    }
    if (current) throw new SessionLockedError(this.keyOf(id), lockHolder(current.owner))
    if (this.closed) throw new SessionLockedError(this.keyOf(id), lockHolder('nobody: the store is closed'))
    const owner = this.processOwner
    const held: Held = { workspace, owner, kind: 'log', holders: new Set([log]), ready: this.takeLease(workspace, id, owner) }
    this.held.set(id, held)
    try {
      await held.ready
    } catch (error) {
      if (this.held.get(id) === held) this.held.delete(id)
      if (error instanceof LeaseTaken) throw new SessionLockedError(this.keyOf(id), lockHolder(error.holder))
      throw error
    }
    this.startRenewing()
  }

  private async releaseForLog(id: string, log: object): Promise<void> {
    const held = this.held.get(id)
    if (held?.kind !== 'log' || !held.holders.delete(log) || held.holders.size > 0) return
    this.held.delete(id)
    this.stopRenewing()
    if (await held.ready.then(() => true, () => false)) await this.dropLease(id, held.owner)
  }

  private async heldElsewhere(workspace: string, id: string): Promise<boolean> {
    const row = await this.sessionRow(this.sql, workspace, id, false)
    if (!row?.leaseOwner || !row.leased || ownerGone(row.leaseOwner)) return false
    const held = this.held.get(id)
    return !(held?.kind === 'log' && held.owner === row.leaseOwner)
  }

  /** Let go of every lease this store holds, and take no more. */
  async releaseAll(): Promise<void> {
    this.closed = true
    const all = [...this.held]
    this.held.clear()
    this.stopRenewing()
    for (const [id, held] of all) {
      if (await held.ready.then(() => true, () => false)) await this.dropLease(id, held.owner).catch(() => undefined)
    }
  }

  async delete(workspace: string, id: string): Promise<void> {
    this.checkId(id)
    const held = this.held.get(id)
    if (held?.kind === 'lease') await this.release(id, held.owner)
    const row = await this.workspaceRow(this.sql, workspace, false)
    if (!row) return
    await this.sql.query(`delete from session where id = $1 and workspace_id = $2`, [id, row.id])
    this.opened.delete(id)
  }

  backend(workspace: string, id: string): SessionBackend {
    this.checkId(id)
    const rows = new PgRowsBackend(this.keyOf(id), {
      load: () => this.loadEvents(workspace, id),
      heldElsewhere: () => this.heldElsewhere(workspace, id),
      hold: log => this.holdForLog(workspace, id, log),
      release: log => this.releaseForLog(id, log),
      create: first => this.createFromLog(workspace, id, first),
      append: events => this.appendFromLog(workspace, id, events),
    })
    const blobs = this.blobs
    const backend = blobs ? new BlobImagesBackend(rows, blobs, this.images) : rows
    this.opened.set(id, { workspace, backend })
    return backend
  }

  private async loadEvents(workspace: string, id: string): Promise<SessionLoad | undefined> {
    if (!await this.sessionRow(this.sql, workspace, id, false)) return undefined
    const { rows } = await this.sql.query(`select event from session_event where session_id = $1 order by seq`, [id])
    if (rows.length === 0) return undefined
    return { events: rows.map(row => eventOf(row)), damaged: false }
  }

  /** A writer found no log: it becomes a Session row with this first event. */
  private async createFromLog(workspace: string, id: string, first: SessionEvent): Promise<void> {
    const summary = summaryFromEvents(workspace, id, [first], 1, first.ts)
    await this.sql.transaction(async tx => {
      await this.insertSession(tx, workspace, id, first, summary, first.ts)
    })
  }

  private async appendFromLog(workspace: string, id: string, events: readonly SessionEvent[]): Promise<void> {
    const first = events[0]
    if (!first) return
    const held = this.held.get(id)
    const owner = held?.kind === 'log' ? held.owner : this.processOwner
    const result = await this.commit(workspace, id, first.seq - 1, events, owner, holder => new SessionLockedError(this.keyOf(id), lockHolder(holder)))
    if (result.status === 'conflict') {
      throw new Error(`session ${id} moved on to seq ${result.headSeq} under another writer; this writer's events from seq ${first.seq} were not stored`)
    }
  }
}

interface RowsOperations {
  load(): Promise<SessionLoad | undefined>
  heldElsewhere(): Promise<boolean>
  hold(log: object): Promise<void>
  release(log: object): Promise<void>
  create(first: SessionEvent): Promise<void>
  append(events: readonly SessionEvent[]): Promise<void>
}

/**
 * Where `SessionLog` keeps a Session in Postgres. Every append is its own
 * committed transaction, so `sync` has nothing left to do, and a log is never
 * torn: repair only adds the closers.
 */
class PgRowsBackend implements SessionBackend {
  constructor(readonly key: string, private readonly rows: RowsOperations) {}

  load(): Promise<SessionLoad | undefined> {
    return this.rows.load()
  }

  heldElsewhere(): Promise<boolean> {
    return this.rows.heldElsewhere()
  }

  hold(owner: object): Promise<void> {
    return this.rows.hold(owner)
  }

  release(owner: object): Promise<void> {
    return this.rows.release(owner)
  }

  create(first: SessionEvent): Promise<void> {
    return this.rows.create(first)
  }

  append(events: readonly SessionEvent[]): Promise<void> {
    return this.rows.append(events)
  }

  async sync(): Promise<void> {}

  repair(closers: readonly SessionEvent[]): Promise<void> {
    return this.rows.append(closers)
  }
}
