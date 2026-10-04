import { randomUUID } from 'node:crypto'
import { BlackboardError, type BlackboardService, type FactRecord } from '@tnega/blackboard'
import { agentAddress, type BoxService } from '@tnega/box'
import type { ThreadService } from '@tnega/thread'
import type { ToolsService } from '@tnega/tools'

/**
 * Routines: recurring work a Project owns.
 *
 * A routine is a stored instruction with a schedule. Each run is delivered to
 * the routine's own thread (created on the first run and reused), so results
 * land in that thread and on the Board like any other work. Routines are
 * Blackboard facts of kind `routine`, which puts them in the snapshot and the
 * change stream for free.
 *
 * They run while the project is mounted in this process. A run that was due
 * while nothing was running happens once on the next tick, not once per missed
 * slot.
 */
export type RoutineSchedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; time: string; weekday: number }
  | { kind: 'interval'; minutes: number }

export interface RoutineData {
  title: string
  prompt: string
  schedule: RoutineSchedule
  enabled: boolean
  /** The thread its runs go to; set on the first run. */
  threadId?: string
  nextRunAt: number
  lastRunAt?: number
  /** Why the last attempt could not start, when it could not. */
  lastError?: string
}

export const MIN_INTERVAL_MINUTES = 5
const RETRY_AFTER_MS = 5 * 60_000
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

export class RoutineError extends Error {
  override name = 'RoutineError'
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RoutineError('expected an object')
  }
  return value as Record<string, unknown>
}

export function normalizeSchedule(input: unknown): RoutineSchedule {
  const value = record(input)
  const time = (): string => {
    if (typeof value.time !== 'string' || !TIME.test(value.time)) {
      throw new RoutineError('time must be HH:MM in 24-hour local time')
    }
    return value.time
  }
  switch (value.kind) {
    case 'daily':
      return { kind: 'daily', time: time() }
    case 'weekdays':
      return { kind: 'weekdays', time: time() }
    case 'weekly': {
      const weekday = value.weekday
      if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        throw new RoutineError('weekday must be 0 (Sunday) to 6 (Saturday)')
      }
      return { kind: 'weekly', time: time(), weekday }
    }
    case 'interval': {
      const minutes = value.minutes
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES) {
        throw new RoutineError(`minutes must be an integer of at least ${MIN_INTERVAL_MINUTES}`)
      }
      return { kind: 'interval', minutes }
    }
    default:
      throw new RoutineError('schedule kind must be daily, weekdays, weekly or interval')
  }
}

/** The first run strictly after `from`, in local time. */
export function nextRun(schedule: RoutineSchedule, from: number): number {
  if (schedule.kind === 'interval') return from + schedule.minutes * 60_000
  const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number]
  const candidate = new Date(from)
  candidate.setSeconds(0, 0)
  candidate.setHours(hours, minutes)
  for (let step = 0; step < 8; step += 1) {
    const day = candidate.getDay()
    const fits = schedule.kind === 'daily'
      || (schedule.kind === 'weekdays' && day >= 1 && day <= 5)
      || (schedule.kind === 'weekly' && day === schedule.weekday)
    if (fits && candidate.getTime() > from) return candidate.getTime()
    candidate.setDate(candidate.getDate() + 1)
    candidate.setHours(hours, minutes)
  }
  throw new RoutineError('schedule never runs')
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case 'daily': return `Every day at ${schedule.time}`
    case 'weekdays': return `Weekdays at ${schedule.time}`
    case 'weekly': return `Every ${WEEKDAYS[schedule.weekday]} at ${schedule.time}`
    case 'interval': return schedule.minutes % 60 === 0
      ? `Every ${schedule.minutes / 60 === 1 ? 'hour' : `${schedule.minutes / 60} hours`}`
      : `Every ${schedule.minutes} minutes`
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new RoutineError(`${name} must be a non-empty string`)
  return value.trim()
}

export interface RoutineScope {
  blackboard: BlackboardService
  threads: ThreadService
  box: BoxService
  coordinatorId: string
}

export class RoutineRunner {
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> | undefined
  private disposed = false

  constructor(private readonly scope: RoutineScope, private readonly now: () => number = Date.now) {}

  start(intervalMs = 30_000): void {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async list(): Promise<FactRecord<RoutineData>[]> {
    return (await this.scope.blackboard.list<RoutineData>('routine')).filter(fact => !fact.deleted)
  }

  async create(input: { title: unknown; prompt: unknown; schedule: unknown; enabled?: unknown }, author: string): Promise<FactRecord<RoutineData>> {
    const schedule = normalizeSchedule(input.schedule)
    const data: RoutineData = {
      title: text(input.title, 'title'),
      prompt: text(input.prompt, 'prompt'),
      schedule,
      enabled: input.enabled !== false,
      nextRunAt: nextRun(schedule, this.now()),
    }
    return await this.scope.blackboard.commit<RoutineData>({
      kind: 'routine', id: randomUUID(), data, author, expectedVersion: null,
    })
  }

  /** Change, pause, resume or delete a routine. */
  async update(id: string, patch: Record<string, unknown>, author: string): Promise<FactRecord<RoutineData>> {
    return await this.change(id, author, current => {
      const next: RoutineData = { ...current }
      if (patch.title !== undefined) next.title = text(patch.title, 'title')
      if (patch.prompt !== undefined) next.prompt = text(patch.prompt, 'prompt')
      if (patch.schedule !== undefined) {
        next.schedule = normalizeSchedule(patch.schedule)
        next.nextRunAt = nextRun(next.schedule, this.now())
      }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw new RoutineError('enabled must be a boolean')
        // Resuming starts from now: a routine paused for a week does not fire at once.
        if (patch.enabled && !current.enabled) next.nextRunAt = nextRun(next.schedule, this.now())
        next.enabled = patch.enabled
      }
      return next
    }, patch.deleted === true)
  }

  /** Run one routine now, whether or not it is due. */
  async run(id: string, author = 'user'): Promise<FactRecord<RoutineData>> {
    const fact = await this.scope.blackboard.read<RoutineData>('routine', id)
    if (!fact || fact.deleted) throw new RoutineError(`routine not found: ${id}`)
    const now = this.now()
    try {
      const threadId = await this.deliver(fact.data, now)
      return await this.change(id, author, current => {
        const next: RoutineData = { ...current, threadId, lastRunAt: now, nextRunAt: nextRun(current.schedule, now) }
        delete next.lastError
        return next
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return await this.change(id, author, current => ({ ...current, lastError: message, nextRunAt: now + RETRY_AFTER_MS }))
    }
  }

  async tick(): Promise<void> {
    if (this.disposed || this.ticking) return
    this.ticking = (async () => {
      const now = this.now()
      for (const fact of await this.list()) {
        if (this.disposed) return
        if (fact.data.enabled && fact.data.nextRunAt <= now) await this.run(fact.id, 'routine').catch(() => undefined)
      }
    })()
    try {
      await this.ticking
    } finally {
      this.ticking = undefined
    }
  }

  /** Send the run to the routine's thread, starting the thread on the first run. */
  private async deliver(routine: RoutineData, now: number): Promise<string> {
    const { threads, box, coordinatorId } = this.scope
    const existing = routine.threadId ? await threads.get(routine.threadId) : undefined
    const thread = existing ?? await threads.spawn({ parentId: coordinatorId, goal: routine.prompt, label: routine.title })
    await box.send({
      sender: agentAddress(coordinatorId),
      recipients: [agentAddress(thread.id)],
      placement: { kind: 'thread', threadId: thread.id },
      kind: 'dispatch',
      text: `Routine "${routine.title}", run of ${new Date(now).toISOString()}.\n\n${routine.prompt}`,
      threadId: thread.id,
    })
    return thread.id
  }

  private async change(
    id: string,
    author: string,
    update: (current: RoutineData) => RoutineData,
    deleted = false,
  ): Promise<FactRecord<RoutineData>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fact = await this.scope.blackboard.read<RoutineData>('routine', id)
      if (!fact || fact.deleted) throw new RoutineError(`routine not found: ${id}`)
      try {
        return await this.scope.blackboard.commit<RoutineData>({
          kind: 'routine',
          id,
          data: update(fact.data),
          author,
          expectedVersion: fact.version,
          ...(deleted ? { deleted: true } : {}),
        })
      } catch (error) {
        if (!(error instanceof BlackboardError && error.code === 'BLACKBOARD_CONFLICT')) throw error
      }
    }
    throw new RoutineError(`routine ${id} kept changing; try again`)
  }
}

const SCHEDULE_PARAMETER = {
  type: 'object',
  description: 'When it runs, in local time.',
  properties: {
    kind: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'interval'] },
    time: { type: 'string', description: 'HH:MM, 24-hour; for daily, weekdays and weekly.' },
    weekday: { type: 'number', description: '0 (Sunday) to 6 (Saturday); for weekly.' },
    minutes: { type: 'number', description: `For interval; at least ${MIN_INTERVAL_MINUTES}.` },
  },
  required: ['kind'],
} as const

function summary(fact: FactRecord<RoutineData>): string {
  const data = fact.data
  const state = data.enabled ? `next ${new Date(data.nextRunAt).toISOString()}` : 'paused'
  return `${fact.id} "${data.title}" — ${describeSchedule(data.schedule)} (${state})${data.lastError ? ` last error: ${data.lastError}` : ''}`
}

/** Model-visible routine tools: the coordinator puts work on a schedule when the user asks. */
export function registerRoutineTools(tools: ToolsService, runner: RoutineRunner): void {
  tools.register({
    schema: {
      name: 'create_routine',
      description: 'Put recurring work on a schedule when the user asks for it ("every weekday at 9", "hourly"). Each run is delivered to the routine\'s own thread, so results land there and on the Board. Write the prompt as a complete brief; it is sent unchanged on every run.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name shown on the Routines tab and the thread card.' },
          prompt: { type: 'string', description: 'The brief each run receives.' },
          schedule: SCHEDULE_PARAMETER,
        },
        required: ['title', 'prompt', 'schedule'],
      },
    },
    async execute(input, options) {
      const value = record(input)
      const fact = await runner.create({ title: value.title, prompt: value.prompt, schedule: value.schedule }, options.agentId ?? 'agent')
      return `Created routine ${summary(fact)}.`
    },
  })

  tools.register({
    schema: {
      name: 'list_routines',
      description: 'List this project\'s routines with their schedule, next run and last error.',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      const facts = await runner.list()
      return facts.length ? facts.map(summary).join('\n') : '(no routines)'
    },
  })

  tools.register({
    schema: {
      name: 'update_routine',
      description: 'Pause, resume, reschedule, rename, rewrite or delete a routine when the user asks.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          schedule: SCHEDULE_PARAMETER,
          enabled: { type: 'boolean' },
          deleted: { type: 'boolean' },
        },
        required: ['id'],
      },
    },
    async execute(input, options) {
      const value = record(input)
      if (typeof value.id !== 'string') throw new RoutineError('id must be a string')
      const { id, ...patch } = value
      const fact = await runner.update(id, patch, options.agentId ?? 'agent')
      return fact.deleted ? `Deleted routine ${id}.` : `Updated routine ${summary(fact)}.`
    },
  })
}
