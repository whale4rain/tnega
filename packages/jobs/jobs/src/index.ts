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
}
export interface JobRead {
  job: JobSnapshot
  output?: string
}
export interface JobStart {
  kind: string
  label: string
  owner?: LiveAgent
  /** Resolve only after execution resources have been released. Observe signal. */
  run(signal: AbortSignal): Promise<JobOutcome>
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
