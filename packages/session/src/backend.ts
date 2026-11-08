import type { SessionEvent } from './index.js'

/** A structurally valid Session event, as read back from storage. */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null) return false
  return 'id' in value && typeof value.id === 'string'
    && 'seq' in value && typeof value.seq === 'number'
    && 'ts' in value && typeof value.ts === 'number'
    && 'type' in value && typeof value.type === 'string'
    && 'payload' in value
}

/** What a backend found when it loaded a log. */
export interface SessionLoad {
  /** The readable events, in stored order. */
  events: SessionEvent[]
  /**
   * The stored log needs repair even without closers: an unreadable tail, or
   * a last record without its line end. {@link SessionBackend.repair} fixes it.
   */
  damaged: boolean
}

/**
 * Where one Session log is stored. `SessionLog` owns the format, the
 * invariants and the in-memory fold; a backend only keeps the events. The
 * local backend is a JSONL file with a lock file; a server keeps rows and a
 * lease. Every method is called from `SessionLog`'s queue, one at a time.
 */
export interface SessionBackend {
  /** The log's identity: the same log always has the same key (a resolved file path locally). */
  readonly key: string
  /** The stored events, or `undefined` when there is no log yet (missing or empty). */
  load(): Promise<SessionLoad | undefined>
  /** Whether another process is writing the log right now. */
  heldElsewhere(): Promise<boolean>
  /** Become a writer. Throws `SessionLockedError` when another process writes it. */
  hold(owner: object): Promise<void>
  /** Stop being a writer; the last writer in this process lets go. */
  release(owner: object): Promise<void>
  /** Store the first event of a new log, all or nothing. */
  create(first: SessionEvent): Promise<void>
  /** Store events after the ones already stored. Durable once {@link sync} resolves. */
  append(events: readonly SessionEvent[]): Promise<void>
  /** Make every appended event durable. */
  sync(): Promise<void>
  /**
   * Fix what the last {@link load} found damaged and store `closers` after
   * it, durably. History before the damage is never rewritten.
   */
  repair(closers: readonly SessionEvent[]): Promise<void>
}
