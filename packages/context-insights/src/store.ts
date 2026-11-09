import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { effectiveLlmConfig, type SystemConfig } from '@tnega/config'
import { workspaceProjectStateRoot, workspaceSessionDir } from '@tnega/home'
import { SessionLog, type SessionEvent } from '@tnega/session'
import type { SessionStore } from '@tnega/session-store'
import { sessionContextReport, type SessionContextReport } from './report.js'
import type { InsightsSource } from './insights.js'

interface Cached { stamp: string; report: SessionContextReport }

/**
 * A history of the workspace: a Session from the Session store, or a Project
 * thread's log file. `stamp` changes whenever the history gains an event.
 */
interface Source {
  key: string
  id: string
  kind: 'session' | 'thread'
  projectId?: string
  threadId?: string
  stamp(): Promise<{ stamp: string; updatedAt: number } | undefined>
  events(): Promise<SessionEvent[]>
}

async function entries(path: string) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

async function stampOf(file: string): Promise<{ stamp: string; mtimeMs: number } | undefined> {
  try {
    const info = await lstat(file)
    return info.isFile() ? { stamp: JSON.stringify([info.size, info.mtimeMs, info.ino]), mtimeMs: info.mtimeMs } : undefined
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Prices and windows change the report; any change to them rebuilds it. */
function configKey(config: SystemConfig): string {
  return createHash('sha256').update(JSON.stringify({
    defaultModel: effectiveLlmConfig(config).modelId,
    contextWindow: config.contextWindow,
    models: config.models?.map(model => ({ id: model.id, model: model.model, pricing: model.pricing, contextWindow: model.contextWindow })),
  })).digest('hex')
}

/**
 * Reports for a workspace's sessions, cached in memory against each history's
 * length and last change. Histories only grow, so an unchanged stamp means an
 * unchanged report. The cache belongs to the plugin and goes with it.
 */
export class ContextReportStore {
  private readonly cache = new Map<string, Cached>()

  /** Sessions are read from `sessions` (`ctx.sessionStore`). */
  constructor(private readonly sessions: SessionStore) {}

  clear(): void {
    this.cache.clear()
  }

  async session(workspace: string, id: string, config: SystemConfig): Promise<SessionContextReport | undefined> {
    return this.report(this.sessionSource(workspace, id), config)
  }

  async workspace(workspace: string, config: SystemConfig): Promise<InsightsSource[]> {
    const sources: Source[] = []
    for (const summary of await this.sessions.list(workspace)) sources.push(this.sessionSource(workspace, summary.id))
    workspaceProjectStateRoot(workspace)
    const projects = join(workspaceSessionDir(workspace), 'projects')
    for (const project of await entries(projects)) {
      if (!project.isDirectory()) continue
      const agents = join(projects, project.name, 'agents')
      for (const thread of await entries(agents)) {
        if (!thread.isDirectory()) continue
        sources.push(threadSource(join(agents, thread.name, 'session.jsonl'), project.name, thread.name))
      }
    }
    const result: InsightsSource[] = []
    const seen = new Set<string>()
    for (const source of sources) {
      seen.add(source.key)
      let report: SessionContextReport | undefined
      try { report = await this.report(source, config) }
      catch { continue } // Listings skip a log that cannot be read, as the session list does.
      if (!report) continue
      const item: InsightsSource = { id: source.id, kind: source.kind, report }
      if (source.projectId) item.projectId = source.projectId
      if (source.threadId) item.threadId = source.threadId
      result.push(item)
    }
    // Deleted sessions leave the cache with their histories.
    const sessionPrefix = sessionKey(workspace, '')
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(sessionPrefix) || key.startsWith(projects)) {
        if (!seen.has(key)) this.cache.delete(key)
      }
    }
    return result
  }

  private sessionSource(workspace: string, id: string): Source {
    return {
      key: sessionKey(workspace, id),
      id,
      kind: 'session',
      stamp: async () => {
        const summary = await this.sessions.summary(workspace, id)
        // Every Session starts with its meta event: no events means no Session.
        return summary.eventCount ? { stamp: JSON.stringify([summary.eventCount, summary.updatedAt]), updatedAt: summary.updatedAt } : undefined
      },
      events: async () => {
        const events: SessionEvent[] = []
        for await (const event of this.sessions.read(workspace, id)) events.push(event)
        return events
      },
    }
  }

  private async report(source: Source, config: SystemConfig): Promise<SessionContextReport | undefined> {
    const before = await source.stamp()
    if (!before) return undefined
    const stamp = `${before.stamp}:${configKey(config)}`
    const cached = this.cache.get(source.key)
    if (cached?.stamp === stamp) return cached.report
    const events = await source.events()
    const report = sessionContextReport(events, config, {
      window: model => effectiveLlmConfig(config, process.env, model).contextWindow,
      updatedAt: Math.max(before.updatedAt, events.at(-1)?.ts ?? 0),
    })
    // A history that changed while it was read is reported but not remembered.
    if ((await source.stamp())?.stamp === before.stamp) this.cache.set(source.key, { stamp, report })
    return report
  }
}

function sessionKey(workspace: string, id: string): string {
  return `session\0${resolve(workspace)}\0${id}`
}

function threadSource(file: string, projectId: string, threadId: string): Source {
  return {
    key: file,
    id: `${projectId}/${threadId}`,
    kind: 'thread',
    projectId,
    threadId,
    stamp: async () => {
      await SessionLog.flushLive(file)
      const info = await stampOf(file)
      return info ? { stamp: info.stamp, updatedAt: info.mtimeMs } : undefined
    },
    events: async () => {
      const log = new SessionLog(file)
      try {
        await log.init()
        return await log.read()
      } finally { await log.close() }
    },
  }
}
