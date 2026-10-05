import type { BackgroundJob, BackgroundProcess } from './api'

/**
 * One row of the Background tasks list: a job of this session (a tool, a
 * shell process or a Subagent run in the background), or a workspace process
 * that outlived the runtime that started it.
 */
export interface BackgroundTask {
  key: string
  source: 'job' | 'process'
  id: string
  kind: 'process' | 'subagent' | 'tool'
  label: string
  status: BackgroundJob['status']
  startedAt: number
  finishedAt?: number
  detail?: string
  urls: string[]
  cwd?: string
}

export const TASK_STATUS: Record<BackgroundJob['status'], string> = {
  running: 'Running', stopping: 'Stopping…', completed: 'Completed', failed: 'Failed', killed: 'Stopped',
}

export function isLive(task: Pick<BackgroundTask, 'status'>): boolean {
  return task.status === 'running' || task.status === 'stopping'
}

/**
 * Jobs and workspace processes as one list: a process a job already shows
 * appears once, live work comes first (newest first), then finished work
 * (most recently finished first).
 */
export function mergeTasks(jobs: readonly BackgroundJob[], processes: readonly BackgroundProcess[]): BackgroundTask[] {
  const claimed = new Set(jobs.flatMap(job => job.processId ? [job.processId] : []))
  const tasks: BackgroundTask[] = [
    ...jobs.map(job => ({
      key: `job:${job.id}`, source: 'job' as const, id: job.id,
      kind: job.kind === 'subagent' ? 'subagent' as const : job.processId ? 'process' as const : 'tool' as const,
      label: job.label, status: job.status, startedAt: job.startedAt,
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      ...(job.detail ? { detail: job.detail } : {}),
      urls: job.urls ?? [],
    })),
    ...processes.filter(process => !claimed.has(process.id)).map(process => ({
      key: `process:${process.id}`, source: 'process' as const, id: process.id, kind: 'process' as const,
      label: process.command, status: process.status, startedAt: process.startedAt,
      ...(typeof process.exitCode === 'number' ? { detail: `exit code ${process.exitCode}` } : {}),
      urls: process.urls, cwd: process.cwd,
    })),
  ]
  const live = tasks.filter(isLive).sort((a, b) => b.startedAt - a.startedAt)
  const done = tasks.filter(task => !isLive(task))
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
  return [...live, ...done]
}

/** `<1s`, `8s`, `2m 13s`, `1h 4m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 1) return '<1s'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The second line of a row: what state it is in and for how long. */
export function taskMeta(task: BackgroundTask, now: number): string {
  if (isLive(task)) {
    const running = `${TASK_STATUS[task.status]} · ${formatElapsed(now - task.startedAt)}`
    return task.source === 'process' ? `${running} · left running in the workspace` : running
  }
  const parts = [TASK_STATUS[task.status]]
  if (task.finishedAt !== undefined) parts.push(`took ${formatElapsed(task.finishedAt - task.startedAt)}`)
  if (task.detail && task.status !== 'completed') parts.push(task.detail)
  return parts.join(' · ')
}

/** `localhost:5173` for a link chip; the full URL stays in the accessible name. */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}
