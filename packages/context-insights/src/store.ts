import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { effectiveLlmConfig, type SystemConfig } from '@tnega/config'
import { workspaceProjectStateRoot, workspaceSessionDir } from '@tnega/home'
import { SessionLog } from '@tnega/session'
import { ensureSessionDir, isSessionId, sessionFile } from '@tnega/session-store'
import { sessionContextReport, type SessionContextReport } from './report.js'
import type { InsightsSource } from './insights.js'

interface Cached { stamp: string; report: SessionContextReport }

/** A source file of the workspace: a session log or a Project thread's log. */
interface SourceFile { id: string; file: string; kind: 'session' | 'thread'; projectId?: string; threadId?: string }

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
 * Reports for a workspace's sessions, cached in memory against each log's
 * size and modification time. Logs only grow, so an unchanged stamp means an
 * unchanged report. The cache belongs to the plugin and goes with it.
 */
export class ContextReportStore {
  private readonly cache = new Map<string, Cached>()

  clear(): void {
    this.cache.clear()
  }

  async session(workspace: string, id: string, config: SystemConfig): Promise<SessionContextReport | undefined> {
    return this.report({ id, file: sessionFile(workspace, id), kind: 'session' }, config)
  }

  async workspace(workspace: string, config: SystemConfig): Promise<InsightsSource[]> {
    const files: SourceFile[] = []
    const dir = await ensureSessionDir(workspace)
    for (const entry of await entries(dir)) {
      const id = entry.name.slice(0, -'.jsonl'.length)
      if (entry.isFile() && entry.name.endsWith('.jsonl') && isSessionId(id)) files.push({ id, file: join(dir, entry.name), kind: 'session' })
    }
    workspaceProjectStateRoot(workspace)
    const projects = join(workspaceSessionDir(workspace), 'projects')
    for (const project of await entries(projects)) {
      if (!project.isDirectory()) continue
      const agents = join(projects, project.name, 'agents')
      for (const thread of await entries(agents)) {
        if (!thread.isDirectory()) continue
        files.push({ id: `${project.name}/${thread.name}`, file: join(agents, thread.name, 'session.jsonl'), kind: 'thread', projectId: project.name, threadId: thread.name })
      }
    }
    const sources: InsightsSource[] = []
    const seen = new Set<string>()
    for (const source of files) {
      seen.add(source.file)
      let report: SessionContextReport | undefined
      try { report = await this.report(source, config) }
      catch { continue } // Listings skip a log that cannot be read, as the session list does.
      if (!report) continue
      const item: InsightsSource = { id: source.id, kind: source.kind, report }
      if (source.projectId) item.projectId = source.projectId
      if (source.threadId) item.threadId = source.threadId
      sources.push(item)
    }
    // Deleted sessions leave the cache with their files.
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${dir}`) || key.startsWith(projects)) {
        if (!seen.has(key)) this.cache.delete(key)
      }
    }
    return sources
  }

  private async report(source: SourceFile, config: SystemConfig): Promise<SessionContextReport | undefined> {
    await SessionLog.flushLive(source.file)
    const before = await stampOf(source.file)
    if (!before) return undefined
    const stamp = `${before.stamp}:${configKey(config)}`
    const cached = this.cache.get(source.file)
    if (cached?.stamp === stamp) return cached.report
    const log = new SessionLog(source.file)
    let events
    try {
      await log.init()
      events = await log.read()
    } finally { await log.close() }
    const report = sessionContextReport(events, config, {
      window: model => effectiveLlmConfig(config, process.env, model).contextWindow,
      updatedAt: Math.max(before.mtimeMs, events.at(-1)?.ts ?? 0),
    })
    // A log that changed while it was read is reported but not remembered.
    if ((await stampOf(source.file))?.stamp === before.stamp) this.cache.set(source.file, { stamp, report })
    return report
  }
}
