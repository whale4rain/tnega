import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionLog, type SessionEvent } from '@tnega/session'
import type { SystemConfig } from './config.js'
import { workspaceSessionDir } from './home-paths.js'
import { workspaceProjectStateRoot } from './state-storage.js'
import { listSessions, readSessionLog } from './store.js'
import { workspaceUsage, type WorkspaceUsage } from './usage.js'

async function directories(path: string) {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

async function hasRegularLog(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile() }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/** The composition layer locates both Session and Project Thread histories. */
export async function storedWorkspaceUsage(workspace: string, config: SystemConfig): Promise<WorkspaceUsage> {
  const sessions = await listSessions(workspace)
  const logs: SessionEvent[][] = await Promise.all(sessions.map(session => readSessionLog(workspace, session.id)))
  const ids = sessions.map(session => session.id)
  const threads = new Map<string, { projectId: string; threadId: string }>()
  workspaceProjectStateRoot(workspace)
  const projects = join(workspaceSessionDir(workspace), 'projects')
  for (const project of await directories(projects)) {
    const agents = join(projects, project.name, 'agents')
    for (const thread of await directories(agents)) {
      const file = join(agents, thread.name, 'session.jsonl')
      if (!await hasRegularLog(file)) continue
      const log = new SessionLog(file)
      try {
        await log.init()
        const events = await log.read()
        if (!events.some(event => event.type === 'assistant/message' && event.payload.usage)) continue
        const id = `${project.name}/${thread.name}`
        ids.push(id)
        logs.push(events)
        threads.set(id, { projectId: project.name, threadId: thread.name })
      } finally { await log.close() }
    }
  }
  const usage = workspaceUsage(logs, config, Date.now(), ids)
  usage.responses = usage.responses.map(response => ({ ...response, ...threads.get(response.sessionId) }))
  return usage
}
