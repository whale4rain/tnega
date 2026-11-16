import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import type { LLMAdapter } from '@tnega/agent'
import { ApprovalBroker } from '@tnega/approval-host'
import { Context } from '@tnega/core'
import type { EffectService } from '@tnega/effects'
import { effectsPg } from '@tnega/effects-pg'
import { workspaceProjectStateRoot } from '@tnega/home'
import { ProjectHost, ROUTINE_SCHEDULE, projectRoutineWakes, routineScheduleKey } from '../src/index.js'

let db: PGlite
const cleanups: Array<() => Promise<void>> = []

beforeAll(async () => {
  db = new PGlite()
  await db.waitReady
})
afterAll(async () => {
  await db.close()
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await db.exec('drop table if exists effect; drop table if exists schedule')
})

/** No background memory extraction: it would still write to the project folder while a test removes it. */
const QUIET = { projectMemory: { enabled: false } }

const llm: LLMAdapter = { complete: async () => ({ finishReason: 'stop', content: 'Report written.' }) }

/** A server's pieces: the control loop on Postgres, and a Project host for one folder that nobody has open. */
async function server(clock: { now: number }) {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-routine-wakes-'))
  cleanups.push(() => rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  cleanups.push(() => rm(workspaceProjectStateRoot(workspace), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const root = new Context()
  const control = await root.plugin(effectsPg, { sql: db, intervalMs: 0, now: () => clock.now })
  cleanups.push(() => control.dispose())
  const effects: EffectService = root.get('effects')
  const hosts: ProjectHost[] = []
  const open = (): ProjectHost => {
    const host = new ProjectHost({ workspace, llm, systemConfig: QUIET, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker(), effects })
    hosts.push(host)
    return host
  }
  cleanups.push(async () => { for (const host of hosts) await host.dispose() })
  return { root, effects, workspace, open }
}

it('mirrors routines into the schedule and runs a due one with no window open', async () => {
  const clock = { now: Date.now() }
  const { root, effects, open } = await server(clock)
  const first = open()
  const record = await first.create({ name: 'Nightly' })
  const routine = await first.createRoutine(record.id, { title: 'Digest', prompt: 'Summarize the day.', schedule: { kind: 'interval', minutes: 5 } })
  const key = routineScheduleKey(record.id, routine.id)
  await expect.poll(async () => (await effects.schedules(ROUTINE_SCHEDULE)).map(entry => entry.key)).toEqual([key])
  const slot = (await effects.schedules(ROUTINE_SCHEDULE))[0]?.nextRunAt ?? 0

  // The window closes and the server restarts: a fresh host has nothing mounted.
  await first.dispose()
  const host = open()
  const wakes = await root.plugin(projectRoutineWakes, { host: async () => host })
  cleanups.push(() => wakes.dispose())
  clock.now = slot
  expect(await effects.tick()).toBe(1)

  const project = await host.mount(record.id)
  const ran = (await project.routines.list()).find(fact => fact.id === routine.id)
  expect(ran?.data.threadId).toBeDefined()
  expect(ran?.data.lastRunAt).toBeDefined()
  const messages = await project.box.timeline()
  expect(messages.some(envelope => envelope.kind === 'dispatch' && envelope.text.includes('Summarize the day.'))).toBe(true)

  // The same slot claimed again does nothing.
  expect(await project.routines.wake(routine.id, slot)).toBe(false)
  const runs = (await project.box.timeline()).filter(envelope => envelope.kind === 'dispatch')
  expect(runs).toHaveLength(1)
})

it('drops the schedule entry of a paused or deleted routine, and of a deleted project', async () => {
  const clock = { now: Date.now() }
  const { effects, open } = await server(clock)
  const host = open()
  const record = await host.create({ name: 'Short' })
  const kept = await host.createRoutine(record.id, { title: 'Kept', prompt: 'p', schedule: { kind: 'daily', time: '09:00' } })
  const paused = await host.createRoutine(record.id, { title: 'Paused', prompt: 'p', schedule: { kind: 'daily', time: '10:00' } })
  await expect.poll(async () => (await effects.schedules()).length).toBe(2)
  await host.updateRoutine(record.id, paused.id, { enabled: false })
  await expect.poll(async () => (await effects.schedules()).map(entry => entry.key)).toEqual([routineScheduleKey(record.id, kept.id)])
  await host.delete(record.id)
  expect(await effects.schedules()).toHaveLength(0)
})
