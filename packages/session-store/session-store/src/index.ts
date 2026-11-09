import { Service, type Context } from '@tnega/core'
import type { ApprovalMode } from '@tnega/approval-review'
import type {
  AgentType,
  ContextUsage,
  SessionBackend,
  SessionEvent,
  SessionMetrics,
  SessionMode,
  SessionPermission,
} from '@tnega/session'

declare module '@tnega/core' {
  interface ServiceMap {
    sessionStore: SessionStore
  }
}

/**
 * The workspace a Session belongs to, as the store names it: a folder path in
 * the local store, a workspace id on a server.
 */
export type WorkspaceKey = string

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A Session id is a UUID in every store; anything else is refused before it reaches one. */
export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}

export interface SessionMetaPayload {
  approvalMode?: ApprovalMode
  title: string
  workspace: string
  createdAt: number
  parentSessionId?: string
  forkedAtMessageId?: string
  agentType?: AgentType
  mode?: SessionMode
  model?: string
  reasoningEffort?: 'default' | 'low' | 'medium' | 'high'
  permission?: SessionPermission
}

/** One Session in a list: its folded metadata, without its events. */
export interface SessionSummary extends SessionMetaPayload {
  id: string
  updatedAt: number
  eventCount: number
}

export interface CreateSessionOptions {
  title?: string
  createdAt?: number
  parentSessionId?: string
  forkedAtMessageId?: string
  agentType?: AgentType
  mode?: SessionMode
  model?: string
  reasoningEffort?: 'default' | 'low' | 'medium' | 'high'
}

export interface SessionMetaPatch {
  title?: string
  agentType?: AgentType
  mode?: SessionMode
  model?: string
  reasoningEffort?: 'default' | 'low' | 'medium' | 'high'
}

export interface SessionSnapshot {
  summary: SessionSummary
  /** The human transcript, with compaction markers in place. */
  events: SessionEvent[]
  /** The model view: shadowed messages removed. */
  surface: SessionEvent[]
  context: ContextUsage
  metrics: SessionMetrics
  /**
   * Every event, for folds that need the whole history (usage, recovery). An
   * assistant message's `stream` copy keeps only its reasoning bounds.
   */
  log: SessionEvent[]
  /** Where the returned transcript starts: a long history is read a page at a time. */
  page: SessionPageRange
}

/** One read of a history: the window returned and how to ask for the one before it. */
export interface SessionPageRange {
  /** Earlier events exist before the window. */
  hasMore: boolean
  /** Pass as beforeSeq for the next older page; absent once the log is covered. */
  beforeSeq?: number
}

/** A request for one page of history, newest last. */
export interface SessionPageOptions {
  /** Return events strictly before this seq; omit for the newest page. */
  beforeSeq?: number
  /** Transcript messages per page; a page never splits a turn. */
  maxMessages?: number
}

export interface SessionSnapshotOptions extends SessionPageOptions {
  /** The context window of a model, when the caller knows it better than the log. */
  windowFor?: (model: string | undefined) => number | undefined
}

/** {@link SessionStore.append}: the events stored, or why not. */
export type SessionAppendResult =
  | { status: 'committed'; seqs: number[] }
  /** Nothing was stored: the log moved past `expectedSeq`, or a retried id came back different. */
  | { status: 'conflict'; headSeq: number }

/** The right to append to one Session, until released or lost. */
export interface SessionLease {
  readonly owner: string
  release(): Promise<void>
}

/** Another writer holds the Session. */
export class SessionLeaseError extends Error {
  readonly code = 'SESSION_LEASED'
  constructor(readonly sessionId: string, readonly holder: string, options?: { cause?: unknown }) {
    super(`session ${sessionId} is being written by ${holder}`, options)
    this.name = 'SessionLeaseError'
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sorted(item)]))
}

/**
 * An event as one canonical string (keys sorted, `undefined` dropped), so a
 * retried append is recognised whatever key order it was built in. Stores
 * compare these, or a hash of them, to tell a retry from a reused id.
 */
export function canonicalEvent(event: SessionEvent): string {
  return JSON.stringify(sorted(event))
}

/**
 * Service Definition of the Session store: where Session logs live and how
 * they are listed, read and appended to. The local Provider keeps JSONL files
 * under `~/.tnega`; a server keeps rows in Postgres. Owns `ctx.sessionStore`.
 *
 * Contract:
 *
 * - **Append-only.** Events are never rewritten; `append` stores a batch
 *   all or nothing at `expectedSeq + 1 …`, or answers `conflict` with the
 *   current head and stores nothing.
 * - **Retries are safe.** A batch whose ids are all stored already, with the
 *   same contents ({@link canonicalEvent}), answers `committed` with the
 *   stored seqs. An id stored with other contents, or only part of a batch
 *   stored, is a `conflict`.
 * - **One writer.** `append` needs the caller's lease (`lease`); another
 *   writer's lease is a {@link SessionLeaseError}. A lease nobody renewed for
 *   30 seconds can be taken over.
 * - **History is the log.** Summaries and snapshots are folds of the events;
 *   `read` returns them exactly as appended.
 */
export abstract class SessionStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionStore')
  }

  abstract create(workspace: WorkspaceKey, options?: CreateSessionOptions): Promise<SessionSummary>
  /**
   * The workspace's Sessions, most recently updated first. A summary counts
   * every event appended so far, so `eventCount` and `updatedAt` together tell
   * a reader whether a Session changed since it last looked.
   */
  abstract list(workspace: WorkspaceKey): Promise<SessionSummary[]>
  abstract summary(workspace: WorkspaceKey, id: string): Promise<SessionSummary>
  abstract snapshot(workspace: WorkspaceKey, id: string, options?: SessionSnapshotOptions): Promise<SessionSnapshot>
  /** Events after `afterSeq`, in order. A missing Session is `SessionNotFoundError`. */
  abstract read(workspace: WorkspaceKey, id: string, afterSeq?: number): AsyncIterable<SessionEvent>
  abstract append(workspace: WorkspaceKey, id: string, request: { expectedSeq: number; events: readonly SessionEvent[]; owner: string }): Promise<SessionAppendResult>
  abstract patchMeta(workspace: WorkspaceKey, id: string, patch: SessionMetaPatch): Promise<SessionSummary>
  /** Take the right to append. Asking again with the same owner keeps it. */
  abstract lease(workspace: WorkspaceKey, id: string, owner: string): Promise<SessionLease>
  abstract delete(workspace: WorkspaceKey, id: string): Promise<void>
  /**
   * Where `SessionLog` keeps this Session's events: the same log that `read`
   * and `append` see. A runtime opens its live log on it.
   */
  abstract backend(workspace: WorkspaceKey, id: string): SessionBackend
}

export const name = '@tnega/session-store'
