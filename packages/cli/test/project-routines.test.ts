import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agents } from '@tnega/agent'
import { blackboardLocal } from '@tnega/blackboard-local'
import { boxBlackboard } from '@tnega/box-blackboard'
import { Context } from '@tnega/core'
import type { SessionEvent } from '@tnega/session'
import { threadLocal } from '@tnega/thread-local'
import { tools } from '@tnega/tools'
import { sessionTotals } from '../src/project-host.js'
import { RoutineError, RoutineRunner, describeSchedule, nextRun, normalizeSchedule } from '../src/project-routines.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })))
})

const project = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Ops',
  coordinatorId: '11111111-1111-4111-8111-111111111111',
}
const llm = { complete: async () => ({ finishReason: 'stop' as const, content: 'ran' }) }

async function mount(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'tnega-routines-'))
  directories.push(root)
  const ctx = new Context()
  await ctx.plugin(tools)
  await ctx.plugin(blackboardLocal, { root: join(root, 'blackboard') })
  await ctx.plugin(boxBlackboard, { projectId: project.id })
  await ctx.plugin(agents)
  await ctx.plugin(threadLocal, { projectId: project.id, root, llm, permission: 'read-only' })
  await ctx.threads.ensureRoot(project)
  return ctx
}

function local(year: number, month: number, day: number, hours: number, minutes: number): number {
  return new Date(year, month - 1, day, hours, minutes).getTime()
}

describe('routine schedules', () => {
  it('finds the next run in local time', () => {
    // 2026-10-02 is a Friday.
    const friday = local(2026, 10, 2, 10, 0)
    expect(nextRun({ kind: 'daily', time: '09:00' }, friday)).toBe(local(2026, 10, 3, 9, 0))
    expect(nextRun({ kind: 'daily', time: '11:30' }, friday)).toBe(local(2026, 10, 2, 11, 30))
    expect(nextRun({ kind: 'weekdays', time: '09:00' }, friday)).toBe(local(2026, 10, 5, 9, 0))
    expect(nextRun({ kind: 'weekly', time: '08:00', weekday: 3 }, friday)).toBe(local(2026, 10, 7, 8, 0))
    expect(nextRun({ kind: 'interval', minutes: 90 }, friday)).toBe(friday + 90 * 60_000)
  })

  it('rejects schedules it cannot run', () => {
    expect(() => normalizeSchedule({ kind: 'daily', time: '9am' })).toThrow(RoutineError)
    expect(() => normalizeSchedule({ kind: 'interval', minutes: 1 })).toThrow(RoutineError)
    expect(() => normalizeSchedule({ kind: 'weekly', time: '09:00', weekday: 7 })).toThrow(RoutineError)
    expect(describeSchedule(normalizeSchedule({ kind: 'interval', minutes: 120 }))).toBe('Every 2 hours')
  })
})

describe('routine runner', () => {
  it('runs a due routine in its own thread and reuses that thread', async () => {
    const ctx = await mount()
    let now = local(2026, 10, 2, 8, 0)
    const runner = new RoutineRunner({ blackboard: ctx.blackboard, threads: ctx.threads, box: ctx.box, coordinatorId: project.coordinatorId }, () => now)
    try {
      const created = await runner.create({ title: 'Morning digest', prompt: 'Summarise new issues.', schedule: { kind: 'daily', time: '09:00' } }, 'user')
      expect(created.data).toMatchObject({ enabled: true, nextRunAt: local(2026, 10, 2, 9, 0) })

      await runner.tick()
      expect((await runner.list())[0]!.data.threadId).toBeUndefined()

      now = local(2026, 10, 2, 9, 1)
      await runner.tick()
      const [first] = await runner.list()
      const threadId = first!.data.threadId!
      expect(await ctx.threads.get(threadId)).toMatchObject({ label: 'Morning digest', parentId: project.coordinatorId })
      expect(first!.data).toMatchObject({ lastRunAt: now, nextRunAt: local(2026, 10, 3, 9, 0) })

      now = local(2026, 10, 3, 9, 5)
      await runner.tick()
      expect((await runner.list())[0]!.data.threadId).toBe(threadId)
      const runs = (await ctx.box.timeline()).filter(envelope => envelope.kind === 'dispatch' && envelope.threadId === threadId)
      expect(runs).toHaveLength(2)
      // Runs stay out of the main conversation.
      expect(runs.every(envelope => envelope.placement.kind === 'thread')).toBe(true)
    } finally {
      runner.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('pauses, resumes from now, and deletes', async () => {
    const ctx = await mount()
    let now = local(2026, 10, 2, 8, 0)
    const runner = new RoutineRunner({ blackboard: ctx.blackboard, threads: ctx.threads, box: ctx.box, coordinatorId: project.coordinatorId }, () => now)
    try {
      const { id } = await runner.create({ title: 'Check', prompt: 'Check.', schedule: { kind: 'interval', minutes: 30 } }, 'user')
      await runner.update(id, { enabled: false }, 'user')
      now += 3 * 60 * 60_000
      await runner.tick()
      expect((await runner.list())[0]!.data.lastRunAt).toBeUndefined()
      const resumed = await runner.update(id, { enabled: true }, 'user')
      expect(resumed.data.nextRunAt).toBe(now + 30 * 60_000)
      await runner.update(id, { deleted: true }, 'user')
      expect(await runner.list()).toEqual([])
    } finally {
      runner.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('thread usage', () => {
  it('adds up tokens and the time spent inside turns', () => {
    const event = (type: string, ts: number, payload: Record<string, unknown> = {}) => ({ id: `${type}-${ts}`, seq: ts, ts, type, payload }) as unknown as SessionEvent
    const totals = sessionTotals([
      event('turn/start', 1_000),
      event('assistant/message', 1_500, { content: 'a', usage: { promptTokens: 100, completionTokens: 20 } }),
      event('turn/end', 4_000),
      event('turn/start', 10_000),
      event('assistant/message', 10_500, { content: 'b', usage: { promptTokens: 50, completionTokens: 5, cachedTokens: 40 } }),
      event('turn/end', 11_000),
    ])
    expect(totals).toEqual({ responses: 2, promptTokens: 150, completionTokens: 25, cachedTokens: 40, activeMs: 4_000, turns: 2 })
  })
})

describe('resolved threads', () => {
  it('records that a person took the result, and reopens on new work', async () => {
    const ctx = await mount()
    try {
      const child = await ctx.threads.spawn({ parentId: project.coordinatorId, goal: 'Draft notes' })
      await ctx.threads.setState(child.id, 'done')
      expect((await ctx.threads.setState(child.id, 'resolved')).state).toBe('resolved')
      expect((await ctx.threads.get(child.id))?.state).toBe('resolved')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
