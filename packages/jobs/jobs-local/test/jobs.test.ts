import { Context } from '@tnega/core'
import { describe, expect, it } from 'vitest'
import { jobsLocal } from '../src/index.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('local background jobs', () => {
  it('does not suppress completion when the only waiter aborted', async () => {
    const root = new Context()
    await root.plugin(jobsLocal)
    root.jobs.attachController()
    const pending = deferred<{ status: 'completed' }>()
    const id = root.jobs.start({ kind: 'tool', label: 'slow', run: () => pending.promise })
    const controller = new AbortController()
    const wait = root.jobs.wait(id, 1000, undefined, controller.signal)
    controller.abort(new Error('no longer waiting'))
    pending.resolve({ status: 'completed' })
    await expect(wait).rejects.toThrow('no longer waiting')
    expect(root.jobs.get(id).reported).toBe(false)
    await root.fiber.dispose()
  })

  it('requires controls before starting work and returns detached snapshots', async () => {
    const root = new Context()
    await root.plugin(jobsLocal)
    const jobs = root.jobs
    let started = false
    expect(() => jobs.start({ kind: 'tool', label: 'slow', run: async () => {
      started = true
      return { status: 'completed' }
    } })).toThrow('controller')
    expect(started).toBe(false)
    jobs.attachController()
    const pending = deferred<{ status: 'completed'; output: string }>()
    const id = jobs.start({ kind: 'tool', label: 'slow', run: () => pending.promise })
    const view = jobs.get(id)
    view.label = 'changed'
    expect(jobs.get(id).label).toBe('slow')
    expect(jobs.get(id).status).toBe('running')
    pending.resolve({ status: 'completed', output: 'done' })
    expect((await jobs.wait(id, 1000)).status).toBe('completed')
    expect(jobs.read(id).output).toBe('done')
    expect(jobs.read(id).output).toBe('done')
    await root.fiber.dispose()
  })

  it('wait timeout and caller abort leave work alive; kill waits for resource release', async () => {
    const root = new Context()
    await root.plugin(jobsLocal)
    root.jobs.attachController()
    const released = deferred<void>()
    let cancelled = false
    const id = root.jobs.start({ kind: 'tool', label: 'slow', run: async signal => {
      signal.addEventListener('abort', () => { cancelled = true }, { once: true })
      await released.promise
      return { status: 'completed', output: 'late result' }
    } })
    expect((await root.jobs.wait(id, 1)).status).toBe('running')
    const caller = new AbortController()
    const wait = root.jobs.wait(id, 1000, undefined, caller.signal)
    caller.abort(new Error('stop waiting'))
    await expect(wait).rejects.toThrow('stop waiting')
    expect(cancelled).toBe(false)
    root.jobs.kill(id)
    expect(cancelled).toBe(true)
    expect(root.jobs.get(id).status).toBe('stopping')
    released.resolve()
    expect((await root.jobs.wait(id, 1000)).status).toBe('killed')
    await root.fiber.dispose()
  })

  it('enforces admission limits and cancels then awaits jobs during disposal', async () => {
    const root = new Context()
    await root.plugin(jobsLocal, { maxConcurrent: 1 })
    root.jobs.attachController()
    const released = deferred<void>()
    let aborted = false
    root.jobs.start({ kind: 'tool', label: 'slow', run: async signal => {
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      await released.promise
      return { status: 'completed' }
    } })
    expect(() => root.jobs.start({ kind: 'tool', label: 'other', run: async () => ({ status: 'completed' }) })).toThrow('limit')
    let disposed = false
    const disposal = root.fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    released.resolve()
    await disposal
    expect(aborted).toBe(true)
  })
})
