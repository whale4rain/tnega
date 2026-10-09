import { describe, expect, it } from 'vitest'
import type { ThreadRecord } from '@tnega/thread'
import type { ToolRequest } from '@tnega/tools'
import { projectAgentRole, projectToolGuard, toolVisible } from '../src/project-tool-scope.js'

const base: ThreadRecord = {
  id: 'c', projectId: 'p', label: 'Project', goal: 'Coordinate', state: 'idle',
  depth: 0, permission: 'workspace-write', createdAt: 0, updatedAt: 0,
}

function call(name: string, agentId?: string): ToolRequest {
  return { name, input: {}, options: agentId ? { agentId } : {}, startedAt: 0 } as unknown as ToolRequest
}

describe('project tool scope', () => {
  it('keeps the coordinator to routing and shared project knowledge', () => {
    const role = projectAgentRole(base, 2)
    expect(role).toEqual({ kind: 'coordinator' })
    for (const name of ['spawn_thread', 'send_thread_message', 'read_project', 'write_memory', 'create_routine']) {
      expect(toolVisible(role, name), name).toBe(true)
    }
    for (const name of ['shell', 'write_file', 'office_create', 'job_start', 'update_checklist', 'read_file', 'grep', 'http_get', 'publish_artifact', 'future_execution_tool']) {
      expect(toolVisible(role, name), name).toBe(false)
    }
  })

  it('gives threads the work tools but not scheduling, and no spawning at the depth limit', () => {
    const thread = projectAgentRole({ ...base, id: 't', parentId: 'c', depth: 1 }, 2)
    expect(toolVisible(thread, 'shell')).toBe(true)
    expect(toolVisible(thread, 'spawn_thread')).toBe(true)
    expect(toolVisible(thread, 'create_routine')).toBe(false)
    const deepest = projectAgentRole({ ...base, id: 'd', parentId: 't', depth: 2 }, 2)
    expect(toolVisible(deepest, 'spawn_thread')).toBe(false)
  })

  it('refuses a hidden tool called by name, and leaves unknown callers alone', async () => {
    const roles = new Map([['c', projectAgentRole(base, 2)]])
    const guard = projectToolGuard(id => roles.get(id))
    expect(await guard(call('shell', 'c'))).toMatch(/dispatch this work to a thread/u)
    expect(await guard(call('read_project', 'c'))).toBeUndefined()
    expect(await guard(call('publish_artifact', 'c'))).toMatch(/dispatch this work/u)
    expect(await guard(call('shell', 'subagent'))).toBeUndefined()
    expect(await guard(call('shell'))).toBeUndefined()
  })
})
