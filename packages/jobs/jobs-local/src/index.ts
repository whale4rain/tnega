import type { Context } from '@tnega/core'
import type { LiveAgent } from '@tnega/agent'
import { JobOwnerDisposedError, JobRegistry, type JobStart, type JobOutcome, type JobSnapshot, type JobRead, type JobDoneListener } from '@tnega/jobs'

export interface JobsLocalConfig { maxConcurrent?: number; maxRetained?: number }
interface Record {
  view: JobSnapshot
  owner: LiveAgent | undefined
  controller: AbortController
  done: Promise<void>
  output?: string
  waiters: Set<() => void>
  progress?: JobStart['progress']
}
function terminal(job: JobSnapshot): boolean {
  return job.status !== 'running' && job.status !== 'stopping'
}

export class LocalJobRegistry extends JobRegistry {
  private readonly records = new Map<string, Record>()
  private readonly owners = new Set<LiveAgent>()
  private readonly listeners = new Set<JobDoneListener>()
  private readonly closingOwners = new WeakSet<LiveAgent>()
  private closed = false
  private controllers = 0
  private counter = 0
  private readonly maxConcurrent: number
  private readonly maxRetained: number

  constructor(ctx: Context, config: JobsLocalConfig = {}) {
    super(ctx)
    this.maxConcurrent = config.maxConcurrent ?? 8
    this.maxRetained = config.maxRetained ?? 256
    for (const value of [this.maxConcurrent, this.maxRetained]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('job limits must be positive integers')
    }
    ctx.effect(() => async () => {
      this.closed = true
      this.listeners.clear()
      await this.disposeRecords([...this.records.values()])
      this.records.clear()
    })
  }

  override attachController(): () => void {
    return this.ctx.effect(() => {
      this.controllers++
      return () => { this.controllers-- }
    })
  }
  override onDone(listener: JobDoneListener): () => void {
    return this.ctx.effect(() => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    })
  }

  override start(spec: JobStart): string {
    if (this.closed || !this.controllers) throw new Error('background jobs require an active controller')
    if (!/^[a-z][a-z0-9-]*$/.test(spec.kind) || !spec.label.trim()) throw new Error('invalid job kind or label')
    if (spec.owner && this.closingOwners.has(spec.owner)) throw new Error('job owner is disposing')
    const active = [...this.records.values()].filter(record => record.owner === spec.owner && !terminal(record.view))
    if (active.length >= this.maxConcurrent) throw new Error('background job concurrency limit reached')
    if (this.records.size >= this.maxRetained) {
      const old = [...this.records.values()].find(record => terminal(record.view) && record.view.reported)
      if (!old) throw new Error('background job retention limit reached; collect job_output first')
      this.records.delete(old.view.id)
    }
    if (spec.owner && !this.owners.has(spec.owner)) {
      const owner = spec.owner
      owner.agentCtx.effect(() => async () => {
        this.closingOwners.add(owner)
        await this.disposeRecords([...this.records.values()].filter(record => record.owner === owner))
        for (const [id, record] of this.records) if (record.owner === owner) this.records.delete(id)
        this.owners.delete(owner)
      })
      this.owners.add(owner)
    }
    const id = `${spec.kind}-${++this.counter}`
    const record: Record = {
      view: { id, kind: spec.kind, label: spec.label, status: 'running', startedAt: Date.now(), reported: false },
      owner: spec.owner, controller: new AbortController(), done: Promise.resolve(), waiters: new Set(),
      ...(spec.progress ? { progress: spec.progress } : {}),
    }
    this.records.set(id, record)
    // Admit and register before the asynchronous producer can allocate resources.
    let work: Promise<JobOutcome>
    try { work = spec.run(record.controller.signal) } catch (error) { work = Promise.reject(error) }
    record.done = work
      .then(outcome => this.settle(record, outcome), error => this.settle(record, {
        status: 'failed', detail: error instanceof Error ? error.message : String(error),
      }))
    this.changed(record)
    return id
  }

  override list(caller?: LiveAgent): JobSnapshot[] {
    return [...this.records.values()].filter(record => this.visible(record, caller)).map(record => this.snapshot(record))
  }
  override get(id: string, caller?: LiveAgent): JobSnapshot { return this.snapshot(this.lookup(id, caller)) }
  override read(id: string, caller?: LiveAgent): JobRead {
    const record = this.lookup(id, caller)
    if (terminal(record.view)) record.view.reported = true
    const output = record.output ?? (terminal(record.view) ? undefined : this.live(record)?.output)
    return { job: this.snapshot(record), ...(output !== undefined ? { output } : {}) }
  }
  override kill(id: string, caller?: LiveAgent, reason = 'background job cancelled'): JobSnapshot {
    const record = this.lookup(id, caller)
    if (!terminal(record.view)) {
      record.view.status = 'stopping'
      record.view.reported = true
      record.controller.abort(new Error(reason))
      this.changed(record)
    }
    return this.snapshot(record)
  }
  override async wait(id: string, timeoutMs: number, caller?: LiveAgent, signal?: AbortSignal): Promise<JobSnapshot> {
    const record = this.lookup(id, caller)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('job wait timeout must be a positive integer')
    if (terminal(record.view)) { record.view.reported = true; return this.snapshot(record) }
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          record.waiters.delete(settled)
          if (error !== undefined && !terminal(record.view)) reject(error)
          else resolve()
        }
        const settled = (): void => finish()
        const abort = (): void => finish(signal?.reason ?? new Error('job wait aborted'))
        const timer = setTimeout(() => finish(), timeoutMs)
        signal?.addEventListener('abort', abort, { once: true })
        record.waiters.add(settled)
      })
    return this.snapshot(record)
  }
  /** The stored view plus what a running job reports about itself right now. */
  private snapshot(record: Record): JobSnapshot {
    const live = this.live(record)
    return {
      ...record.view,
      ...(live?.urls?.length ? { urls: [...live.urls] } : {}),
      ...(live?.processId ? { processId: live.processId } : {}),
    }
  }
  private live(record: Record): ReturnType<NonNullable<JobStart['progress']>> {
    try { return record.progress?.() } catch { return undefined }
  }
  private visible(record: Record, caller?: LiveAgent): boolean {
    return record.owner === undefined || record.owner === caller
  }
  private lookup(id: string, caller?: LiveAgent): Record {
    const record = this.records.get(id)
    if (!record || !this.visible(record, caller)) throw new Error('background job not found')
    return record
  }
  private settle(record: Record, outcome: JobOutcome): void {
    if (terminal(record.view)) return
    record.view.status = record.controller.signal.aborted ? 'killed' : outcome.status
    record.view.finishedAt = Date.now()
    if (outcome.detail) record.view.detail = outcome.detail
    if (outcome.output !== undefined) record.output = outcome.output
    if (record.waiters.size > 0) record.view.reported = true
    // Keep the last live view (URLs, process) on the finished record.
    const live = this.live(record)
    if (live?.urls?.length) record.view.urls = [...live.urls]
    if (live?.processId) record.view.processId = live.processId
    if (record.output === undefined && live?.output !== undefined) record.output = live.output
    this.changed(record)
    for (const finish of [...record.waiters]) finish()
    if (!this.closed) for (const listener of this.listeners) {
      try { void Promise.resolve(listener({ ...record.view }, record.owner)).catch(() => undefined) } catch { /* observer isolation */ }
    }
  }
  private changed(record: Record): void {
    try { this.ctx.emit('jobs/change', this.snapshot(record)) } catch { /* observer isolation */ }
  }
  private async disposeRecords(records: Record[]): Promise<void> {
    for (const record of records) {
      if (!terminal(record.view)) {
        record.view.status = 'stopping'
        record.view.reported = true
        record.controller.abort(new JobOwnerDisposedError())
      }
    }
    await Promise.all(records.map(record => record.done))
  }
}
export const jobsLocal = { name: 'jobs-local', apply(ctx: Context, config: JobsLocalConfig = {}): void {
  new LocalJobRegistry(ctx, config)
} }
