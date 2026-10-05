import { Service, type Context } from '@tnega/core'
import type { LiveAgent } from '@tnega/agent'

export type JobStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'killed'
export interface JobOutcome {
  status: 'completed' | 'failed' | 'killed'
  output?: string
  detail?: string
}
export interface JobSnapshot {
  id: string
  kind: string
  label: string
  status: JobStatus
  startedAt: number
  finishedAt?: number
  detail?: string
  reported: boolean
  /** Local URLs a process job printed, such as a dev server's address. */
  urls?: string[]
  /** The workspace process backing a process job, when it has one. */
  processId?: string
}
export interface JobRead {
  job: JobSnapshot
  /** The final output once finished; the output so far while a live job runs. */
  output?: string
}
/** What a running job can show before it finishes. */
export interface JobProgress {
  output?: string
  urls?: string[]
  processId?: string
}
export interface JobStart {
  kind: string
  label: string
  owner?: LiveAgent
  /** Resolve only after execution resources have been released. Observe signal. */
  run(signal: AbortSignal): Promise<JobOutcome>
  /** Live view of a job that produces output while it runs (a process). */
  progress?(): JobProgress | undefined
}

/**
 * The abort reason when a job's owner Agent or the registry itself goes away,
 * as opposed to a person or the model stopping it. Work that a host keeps
 * beyond one runtime (a dev server in the workspace registry) may detach on
 * this reason instead of stopping.
 */
export class JobOwnerDisposedError extends Error {
  override name = 'JobOwnerDisposedError'
  constructor() { super('job owner disposed') }
}
export type JobDoneListener = (job: JobSnapshot, owner?: LiveAgent) => void | Promise<void>

declare module '@tnega/core' {
  interface Context { jobs: JobRegistry }
  interface Events {
    'jobs/change': (job: JobSnapshot) => void
  }
}

/** Process-local work owned by an exact Agent lifecycle, or the registry itself. */
export abstract class JobRegistry extends Service {
  constructor(ctx: Context) {
    if (new.target === JobRegistry) throw new Error('jobs requires a Provider')
    super(ctx, 'jobs')
  }
  abstract start(spec: JobStart): string
  abstract list(caller?: LiveAgent): JobSnapshot[]
  abstract get(id: string, caller?: LiveAgent): JobSnapshot
  abstract read(id: string, caller?: LiveAgent): JobRead
  abstract kill(id: string, caller?: LiveAgent, reason?: string): JobSnapshot
  abstract wait(id: string, timeoutMs: number, caller?: LiveAgent, signal?: AbortSignal): Promise<JobSnapshot>
  abstract attachController(): () => void
  abstract onDone(listener: JobDoneListener): () => void
}
