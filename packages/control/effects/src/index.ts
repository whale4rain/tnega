import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface ServiceMap {
    effects: EffectService
  }
}

/**
 * `ctx.effects`: the server's outside actions, stored first and carried out
 * after (v2 server MVP §4.2), and the schedules that turn into them (§4.5).
 *
 * - An **effect** is a stable `kind` + `key` with a payload and a due time.
 *   Enqueueing the same `kind` + `key` twice keeps the first one, so a
 *   decision that is retried does not act twice. A handler runs it after the
 *   enqueue is durable; success removes it, failure retries it later with
 *   backoff (2 s, doubling to 60 s). An effect whose kind no handler in this
 *   process knows waits for a process that does.
 * - Handlers must be safe to repeat: a crash after the outside action but
 *   before the effect is removed runs it again.
 * - A **schedule** is a recurring entry (`kind` + `key`, a spec and the next
 *   run time). When it is due, claiming it enqueues one effect keyed by the
 *   entry and its run time and moves the entry to its next run, in one step,
 *   so a run cannot happen twice for the same time even with two servers.
 *   The schedule kind says which effect to enqueue and when the next run is.
 */

export interface EffectInput {
  kind: string
  /** Stable for one decision: the same kind and key are one effect. */
  key: string
  payload: Readonly<Record<string, unknown>>
  /** Milliseconds since the epoch; default now. */
  dueAt?: number
}

export interface Effect {
  id: string
  kind: string
  key: string
  payload: Record<string, unknown>
  dueAt: number
  /** How many times a handler has taken it. */
  attempts: number
  /** Why the last attempt failed, when it did. */
  lastError?: string
}

/** Run one effect; throw to have it retried later. */
export type EffectHandler = (effect: Effect, signal: AbortSignal) => Promise<void>

export interface ScheduleEntry {
  /** A registered {@link ScheduleKind}. */
  kind: string
  key: string
  spec: Readonly<Record<string, unknown>>
  nextRunAt: number
}

export interface ScheduleKind {
  /** The effect a due run enqueues. */
  effect: string
  /** The payload of that effect. Default: the spec plus `runAt`. */
  payload?(entry: ScheduleEntry, runAt: number): Record<string, unknown>
  /** The next run strictly after `after`; `undefined` ends the schedule. */
  next(spec: Readonly<Record<string, unknown>>, after: number): number | undefined
}

/** An effect that failed this many times in a row is a problem to show. */
export const EFFECT_PROBLEM_ATTEMPTS = 3

/** The wait before the next attempt after `attempts` failures: 2 s doubling to 60 s. */
export function effectBackoffMs(attempts: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempts - 1))
}

/** The key of a scheduled run's effect: one per entry and run time. */
export function scheduledRunKey(entry: Pick<ScheduleEntry, 'kind' | 'key'>, runAt: number): string {
  return `${entry.kind}:${entry.key}:${runAt}`
}

export abstract class EffectService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'effects')
  }

  /** Store an effect; it runs once a handler for its kind is registered and it is due. */
  abstract enqueue(input: EffectInput): Promise<void>

  /** Handle every effect of `kind` in this process; the returned function stops it. */
  abstract handle(kind: string, handler: EffectHandler): () => void

  /** Say how entries of `kind` run; the returned function stops claiming them in this process. */
  abstract scheduleKind(kind: string, definition: ScheduleKind): () => void

  /** Add or replace a schedule entry (by kind and key). */
  abstract schedule(entry: ScheduleEntry): Promise<void>

  abstract unschedule(kind: string, key: string): Promise<void>

  abstract schedules(kind?: string): Promise<ScheduleEntry[]>

  /** Effects waiting to run, oldest first. */
  abstract pending(kind?: string): Promise<Effect[]>

  /** Effects that failed {@link EFFECT_PROBLEM_ATTEMPTS} times in a row, for an admin page. */
  abstract problems(): Promise<Effect[]>

  /**
   * Claim due schedules and run due effects once. The Provider's loop calls
   * it on a timer; a caller that just enqueued something may call it so the
   * effect does not wait for the next round. Returns how many effects ran.
   */
  abstract tick(): Promise<number>
}

export const name = '@tnega/effects'
