import pg from 'pg'
import type { Context } from '@tnega/core'
import {
  EFFECT_PROBLEM_ATTEMPTS,
  EffectService,
  effectBackoffMs,
  scheduledRunKey,
  type Effect,
  type EffectHandler,
  type EffectInput,
  type ScheduleEntry,
  type ScheduleKind,
} from '@tnega/effects'
import { millis, optionalText, poolClient, text, type SqlClient, type SqlQueryable } from './sql.js'

export { poolClient, type PgPoolLike, type SqlClient, type SqlQueryable } from './sql.js'

/**
 * Tables of `ctx.effects` on Postgres. `schedule` generalizes the plan's
 * `(project_id, routine_id)` row to `(kind, key)`, so routines are one kind
 * among others.
 */
const TABLES = [
  `create table if not exists effect (
    id bigserial primary key, kind text not null, key text not null,
    payload jsonb not null, due_at timestamptz not null,
    attempts int not null default 0, last_error text,
    unique (kind, key)
  )`,
  `create index if not exists effect_due on effect (due_at)`,
  `create table if not exists schedule (
    kind text not null, key text not null, spec jsonb not null,
    next_run_at timestamptz not null,
    primary key (kind, key)
  )`,
  `create index if not exists schedule_due on schedule (next_run_at)`,
]

export async function bootstrapEffectTables(sql: SqlClient): Promise<void> {
  await sql.transaction(async tx => {
    await tx.query(`select pg_advisory_xact_lock(7104553553)`)
    for (const statement of TABLES) await tx.query(statement)
  })
}

export interface EffectsPgConfig {
  /** `postgresql://…`; the plugin opens a small pool and closes it with the plugin. */
  url?: string
  /** A client the caller owns (PGlite in tests). Wins over `url`. */
  sql?: SqlClient
  bootstrap?: boolean
  /** How often due schedules and effects are looked at. Default 2 s; 0 runs no loop (tests call `tick`). */
  intervalMs?: number
  /** How long a taken effect is held before another round may take it again. Default 5 minutes. */
  leaseMs?: number
  /** Most effects one round takes. Default 10. */
  batch?: number
  /** The clock; tests move it. */
  now?: () => number
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return record(JSON.parse(value))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('expected a JSON object')
  return Object.fromEntries(Object.entries(value))
}

function field(row: unknown, column: string): unknown {
  return typeof row === 'object' && row !== null ? Reflect.get(row, column) : undefined
}

function effectFrom(row: unknown): Effect {
  const lastError = optionalText(row, 'last_error')
  const attempts = Number(field(row, 'attempts'))
  return {
    id: text(row, 'id'),
    kind: text(row, 'kind'),
    key: text(row, 'key'),
    payload: record(field(row, 'payload')),
    dueAt: millis(row, 'due_at'),
    attempts: Number.isFinite(attempts) ? attempts : 0,
    ...(lastError === undefined ? {} : { lastError }),
  }
}

function entryFrom(row: unknown): ScheduleEntry {
  return { kind: text(row, 'kind'), key: text(row, 'key'), spec: record(field(row, 'spec')), nextRunAt: millis(row, 'next_run_at') }
}

const EFFECT_COLUMNS = `id::text as id, kind, key, payload, due_at, attempts, last_error`
const SCHEDULE_COLUMNS = `kind, key, spec, next_run_at`

export class PgEffectService extends EffectService {
  private readonly handlers = new Map<string, EffectHandler>()
  private readonly kinds = new Map<string, ScheduleKind>()
  private readonly abort = new AbortController()
  private running: Promise<number> | undefined
  private again = false
  private soonTimer: NodeJS.Immediate | undefined

  constructor(ctx: Context, private readonly sql: SqlClient, private readonly config: EffectsPgConfig = {}) {
    super(ctx)
  }

  private now(): number {
    return this.config.now?.() ?? Date.now()
  }

  async enqueue(input: EffectInput): Promise<void> {
    await this.sql.query(
      `insert into effect (kind, key, payload, due_at) values ($1, $2, $3::jsonb, $4::timestamptz)
       on conflict (kind, key) do nothing`,
      [input.kind, input.key, JSON.stringify(input.payload), iso(input.dueAt ?? this.now())],
    )
    if (this.handlers.has(input.kind)) this.soon()
  }

  handle(kind: string, handler: EffectHandler): () => void {
    if (this.handlers.has(kind)) throw new Error(`effects of kind ${kind} already have a handler`)
    this.handlers.set(kind, handler)
    this.soon()
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind)
    }
  }

  scheduleKind(kind: string, definition: ScheduleKind): () => void {
    if (this.kinds.has(kind)) throw new Error(`schedule kind ${kind} is already defined`)
    this.kinds.set(kind, definition)
    this.soon()
    return () => {
      if (this.kinds.get(kind) === definition) this.kinds.delete(kind)
    }
  }

  async schedule(entry: ScheduleEntry): Promise<void> {
    await this.sql.query(
      `insert into schedule (kind, key, spec, next_run_at) values ($1, $2, $3::jsonb, $4::timestamptz)
       on conflict (kind, key) do update set spec = excluded.spec, next_run_at = excluded.next_run_at`,
      [entry.kind, entry.key, JSON.stringify(entry.spec), iso(entry.nextRunAt)],
    )
    if (this.kinds.has(entry.kind) && entry.nextRunAt <= this.now()) this.soon()
  }

  async unschedule(kind: string, key: string): Promise<void> {
    await this.sql.query(`delete from schedule where kind = $1 and key = $2`, [kind, key])
  }

  async schedules(kind?: string): Promise<ScheduleEntry[]> {
    const { rows } = kind === undefined
      ? await this.sql.query(`select ${SCHEDULE_COLUMNS} from schedule order by next_run_at, kind, key`)
      : await this.sql.query(`select ${SCHEDULE_COLUMNS} from schedule where kind = $1 order by next_run_at, key`, [kind])
    return rows.map(entryFrom)
  }

  async pending(kind?: string): Promise<Effect[]> {
    const { rows } = kind === undefined
      ? await this.sql.query(`select ${EFFECT_COLUMNS} from effect order by due_at, id`)
      : await this.sql.query(`select ${EFFECT_COLUMNS} from effect where kind = $1 order by due_at, id`, [kind])
    return rows.map(effectFrom)
  }

  async problems(): Promise<Effect[]> {
    const { rows } = await this.sql.query(
      `select ${EFFECT_COLUMNS} from effect where last_error is not null and attempts >= $1 order by due_at, id`,
      [EFFECT_PROBLEM_ATTEMPTS],
    )
    return rows.map(effectFrom)
  }

  /** One round at a time; a call during a round asks for one more round after it. */
  tick(): Promise<number> {
    if (this.running) {
      this.again = true
      return this.running
    }
    const round = (async () => {
      let ran = 0
      // A few extra rounds for work that arrived meanwhile; the timer picks up the rest.
      for (let round = 0; round < 4; round += 1) {
        this.again = false
        if (this.abort.signal.aborted) break
        await this.claimSchedules()
        ran += await this.runDue()
        if (!this.again) break
      }
      return ran
    })()
    this.running = round
    return round.finally(() => {
      if (this.running === round) this.running = undefined
    })
  }

  /** Ask for a round soon, without waiting for the timer. */
  private soon(): void {
    if (this.soonTimer || this.abort.signal.aborted) return
    this.soonTimer = setImmediate(() => {
      this.soonTimer = undefined
      void this.tick().catch(() => undefined)
    })
  }

  /** Turn due schedule entries into effects and move each to its next run, in one transaction. */
  private async claimSchedules(): Promise<void> {
    const kinds = [...this.kinds.keys()]
    if (!kinds.length) return
    const now = this.now()
    await this.sql.transaction(async tx => {
      const { rows } = await tx.query(
        `select ${SCHEDULE_COLUMNS} from schedule where next_run_at <= $1::timestamptz and kind = any($2::text[])
         order by next_run_at limit $3 for update skip locked`,
        [iso(now), kinds, this.config.batch ?? 10],
      )
      for (const entry of rows.map(entryFrom)) await this.claimEntry(tx, entry, now)
    })
  }

  private async claimEntry(tx: SqlQueryable, entry: ScheduleEntry, now: number): Promise<void> {
    const definition = this.kinds.get(entry.kind)
    if (!definition) return
    let next: number | undefined
    let payload: Record<string, unknown>
    try {
      // A run missed while nothing ran happens once, not once per missed slot.
      next = definition.next(entry.spec, Math.max(now, entry.nextRunAt))
      payload = definition.payload?.(entry, entry.nextRunAt) ?? { ...entry.spec, runAt: entry.nextRunAt }
    } catch {
      // A spec this process cannot read would be claimed forever: drop it.
      await tx.query(`delete from schedule where kind = $1 and key = $2`, [entry.kind, entry.key])
      return
    }
    await tx.query(
      `insert into effect (kind, key, payload, due_at) values ($1, $2, $3::jsonb, $4::timestamptz)
       on conflict (kind, key) do nothing`,
      [definition.effect, scheduledRunKey(entry, entry.nextRunAt), JSON.stringify(payload), iso(now)],
    )
    if (next === undefined || !Number.isFinite(next) || next <= entry.nextRunAt) {
      await tx.query(`delete from schedule where kind = $1 and key = $2`, [entry.kind, entry.key])
    } else {
      await tx.query(`update schedule set next_run_at = $3::timestamptz where kind = $1 and key = $2`, [entry.kind, entry.key, iso(next)])
    }
  }

  /** Take due effects this process can run, hold them for the lease, and run them. */
  private async runDue(): Promise<number> {
    const kinds = [...this.handlers.keys()]
    if (!kinds.length) return 0
    const now = this.now()
    const { rows } = await this.sql.query(
      `update effect set due_at = $1::timestamptz, attempts = attempts + 1
       where id in (
         select id from effect where due_at <= $2::timestamptz and kind = any($3::text[])
         order by due_at, id limit $4 for update skip locked
       )
       returning ${EFFECT_COLUMNS}`,
      [iso(now + (this.config.leaseMs ?? 5 * 60_000)), iso(now), kinds, this.config.batch ?? 10],
    )
    const taken = rows.map(effectFrom)
    await Promise.all(taken.map(effect => this.runOne(effect)))
    return taken.length
  }

  private async runOne(effect: Effect): Promise<void> {
    const handler = this.handlers.get(effect.kind)
    if (!handler) return
    try {
      await handler(effect, this.abort.signal)
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
      // Only the attempt that took it may write it back: a later round may have taken it again.
      await this.sql.query(
        `update effect set due_at = $3::timestamptz, last_error = $4 where id = $1::bigint and attempts = $2`,
        [effect.id, effect.attempts, iso(this.now() + effectBackoffMs(effect.attempts)), message],
      ).catch(() => undefined)
      return
    }
    await this.sql.query(`delete from effect where id = $1::bigint and attempts = $2`, [effect.id, effect.attempts]).catch(() => undefined)
  }

  /** Stop the loop and every handler's signal; waits for the round under way. */
  async close(): Promise<void> {
    this.abort.abort()
    if (this.soonTimer) clearImmediate(this.soonTimer)
    this.soonTimer = undefined
    await this.running?.catch(() => undefined)
  }
}

/**
 * Mount: `await ctx.plugin(effectsPg, { url: process.env.DATABASE_URL })`.
 * The loop stops, and a pool the plugin opened is closed, with the plugin.
 */
export const effectsPg = {
  name: 'effects-pg',
  async apply(ctx: Context, config: EffectsPgConfig): Promise<void> {
    const pool = config.sql ? undefined : new pg.Pool({ connectionString: config.url, max: 4 })
    const sql = config.sql ?? (pool ? poolClient(pool) : undefined)
    if (!sql) throw new TypeError('effects-pg needs a url or a sql client')
    try {
      if (config.bootstrap !== false) await bootstrapEffectTables(sql)
    } catch (error) {
      await pool?.end()
      throw error
    }
    const service = new PgEffectService(ctx, sql, config)
    const intervalMs = config.intervalMs ?? 2_000
    const timer = intervalMs > 0 ? setInterval(() => { void service.tick().catch(() => undefined) }, intervalMs) : undefined
    timer?.unref()
    ctx.fiber.effect(() => async () => {
      if (timer) clearInterval(timer)
      await service.close()
      await pool?.end()
    }, 'effects-pg/loop')
  },
}

export const name = '@tnega/effects-pg'
