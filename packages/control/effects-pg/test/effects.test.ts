import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { EFFECT_PROBLEM_ATTEMPTS, effectBackoffMs, type Effect, type EffectService } from '@tnega/effects'
import { effectsPg } from '../src/index.js'

let db: PGlite
let clock = Date.UTC(2026, 10, 16, 9, 0)
const cleanups: Array<() => Promise<void>> = []

beforeAll(async () => {
  db = new PGlite()
  await db.waitReady
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  clock = Date.UTC(2026, 10, 16, 9, 0)
  await db.exec('drop table if exists effect; drop table if exists schedule')
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function mount(): Promise<EffectService> {
  const ctx = new Context()
  const mounted = await ctx.plugin(effectsPg, { sql: db, intervalMs: 0, now: () => clock })
  cleanups.push(() => mounted.dispose())
  return ctx.get('effects')
}

it('runs an effect once and removes it; the same kind and key enqueued again is one effect', async () => {
  const effects = await mount()
  const seen: Effect[] = []
  effects.handle('notify', async effect => { seen.push(effect) })
  await effects.enqueue({ kind: 'notify', key: 'a', payload: { text: 'hi' } })
  await effects.enqueue({ kind: 'notify', key: 'a', payload: { text: 'again' } })
  expect(await effects.pending()).toHaveLength(1)
  expect(await effects.tick()).toBe(1)
  expect(seen.map(effect => effect.payload)).toEqual([{ text: 'hi' }])
  expect(await effects.pending()).toHaveLength(0)
})

it('keeps an effect for a process that knows its kind, and one that is not due yet', async () => {
  const effects = await mount()
  await effects.enqueue({ kind: 'machine.start', key: 'm1', payload: {} })
  await effects.enqueue({ kind: 'notify', key: 'later', payload: {}, dueAt: clock + 60_000 })
  const seen: string[] = []
  effects.handle('notify', async effect => { seen.push(effect.key) })
  expect(await effects.tick()).toBe(0)
  expect((await effects.pending()).map(effect => effect.kind).sort()).toEqual(['machine.start', 'notify'])
  clock += 60_000
  expect(await effects.tick()).toBe(1)
  expect(seen).toEqual(['later'])
})

it('retries a failing effect with backoff and shows it as a problem after three failures', async () => {
  const effects = await mount()
  let fail = true
  let calls = 0
  effects.handle('run.wake', async () => {
    calls += 1
    if (fail) throw new Error('box would not start')
  })
  await effects.enqueue({ kind: 'run.wake', key: 's1', payload: {} })
  for (let attempt = 1; attempt <= EFFECT_PROBLEM_ATTEMPTS; attempt += 1) {
    expect(await effects.tick()).toBe(1)
    const [pending] = await effects.pending()
    expect(pending).toMatchObject({ attempts: attempt, lastError: 'box would not start', dueAt: clock + effectBackoffMs(attempt) })
    // Not due again before its backoff.
    expect(await effects.tick()).toBe(0)
    clock += effectBackoffMs(attempt)
  }
  expect(await effects.problems()).toHaveLength(1)
  fail = false
  expect(await effects.tick()).toBe(1)
  expect(calls).toBe(EFFECT_PROBLEM_ATTEMPTS + 1)
  expect(await effects.pending()).toHaveLength(0)
  expect(await effects.problems()).toHaveLength(0)
  expect([1, 2, 3, 6, 9].map(effectBackoffMs)).toEqual([2_000, 4_000, 8_000, 60_000, 60_000])
})

it('holds a taken effect for its lease, so a second server does not run it at the same time', async () => {
  const first = await mount()
  const second = await mount()
  let release: () => void = () => undefined
  const started: string[] = []
  first.handle('notify', effect => {
    started.push(`first ${effect.key}`)
    return new Promise<void>(done => { release = done })
  })
  second.handle('notify', async effect => { started.push(`second ${effect.key}`) })
  await first.enqueue({ kind: 'notify', key: 'once', payload: {} })
  const running = first.tick()
  await new Promise(done => setTimeout(done, 20))
  expect(await second.tick()).toBe(0)
  release()
  await running
  expect(started).toEqual(['first once'])
})

it('turns a due schedule into one effect per run time and moves it to its next run', async () => {
  const effects = await mount()
  const hour = 3_600_000
  effects.scheduleKind('routine', { effect: 'run.wake', next: (spec, after) => after + Number(spec.everyMs) })
  const runs: Array<Record<string, unknown>> = []
  effects.handle('run.wake', async effect => { runs.push(effect.payload) })
  await effects.schedule({ kind: 'routine', key: 'p1/r1', spec: { everyMs: hour }, nextRunAt: clock + hour })
  expect(await effects.tick()).toBe(0)
  clock += hour
  expect(await effects.tick()).toBe(1)
  expect(runs).toEqual([{ everyMs: hour, runAt: clock }])
  expect((await effects.schedules('routine'))[0]?.nextRunAt).toBe(clock + hour)
  // Missed for a day: it runs once, then on from now.
  clock += 24 * hour
  expect(await effects.tick()).toBe(1)
  expect(runs).toHaveLength(2)
  expect((await effects.schedules())[0]?.nextRunAt).toBe(clock + hour)
})

it('claims a schedule once when two servers look at the same time', async () => {
  const first = await mount()
  const second = await mount()
  for (const effects of [first, second]) {
    effects.scheduleKind('routine', { effect: 'run.wake', next: (_spec, after) => after + 60_000 })
  }
  await first.schedule({ kind: 'routine', key: 'p1/r1', spec: {}, nextRunAt: clock })
  await Promise.all([first.tick(), second.tick()])
  expect(await first.pending('run.wake')).toHaveLength(1)
})

it('ends a schedule whose kind has no next run, and drops one whose spec cannot be read', async () => {
  const effects = await mount()
  effects.scheduleKind('once', { effect: 'notify', next: () => undefined })
  effects.scheduleKind('broken', { effect: 'notify', next: () => { throw new Error('bad spec') } })
  await effects.schedule({ kind: 'once', key: 'x', spec: {}, nextRunAt: clock })
  await effects.schedule({ kind: 'broken', key: 'y', spec: {}, nextRunAt: clock })
  await effects.tick()
  expect(await effects.schedules()).toHaveLength(0)
  expect((await effects.pending('notify')).map(effect => effect.key)).toEqual([`once:x:${clock}`])
  await effects.unschedule('once', 'x')
})

it('refuses a second handler for a kind and lets go of one on dispose', async () => {
  const effects = await mount()
  const stop = effects.handle('notify', async () => undefined)
  expect(() => effects.handle('notify', async () => undefined)).toThrow(/already/)
  stop()
  effects.handle('notify', async () => undefined)
})
