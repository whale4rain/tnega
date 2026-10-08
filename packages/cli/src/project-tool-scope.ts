import type { AgentRequestEvent } from '@tnega/agent'
import type { Context } from '@tnega/core'
import type { ThreadRecord } from '@tnega/thread'
import type { ToolGuard } from '@tnega/tools'

/**
 * Toy builtins a Project Agent never needs: they only add schema to every request.
 * `now` stays because routines and reports reason about dates.
 */
export const PROJECT_DISABLED_BUILTINS: readonly string[] = ['echo', 'calculator', 'json']

/**
 * What the coordinator must not do itself. It routes work, so execution and
 * deliverable-producing tools belong to threads; read and search tools stay
 * so it can answer quick questions and brief threads precisely.
 */
const COORDINATOR_HIDDEN: ReadonlySet<string> = new Set([
  'shell',
  'write_file',
  'edit_file',
  'office_create',
  'office_edit',
  'skill_create',
  'skill_install',
  'job_start',
  'job_list',
  'job_output',
  'job_kill',
  'update_checklist',
])

/** Routines are scheduled by the coordinator; a thread is one run, not a scheduler. */
const THREAD_HIDDEN: ReadonlySet<string> = new Set([
  'create_routine',
  'update_routine',
  'list_routines',
])

export type ProjectAgentRole =
  | { kind: 'coordinator' }
  | { kind: 'thread'; canSpawn: boolean }

export function projectAgentRole(record: ThreadRecord, maxDepth: number): ProjectAgentRole {
  if (record.parentId === undefined) return { kind: 'coordinator' }
  return { kind: 'thread', canSpawn: record.depth < maxDepth }
}

/** Whether a tool is part of this role's model-visible surface. */
export function toolVisible(role: ProjectAgentRole, name: string): boolean {
  if (role.kind === 'coordinator') return !COORDINATOR_HIDDEN.has(name)
  if (THREAD_HIDDEN.has(name)) return false
  return role.canSpawn || name !== 'spawn_thread'
}

/**
 * Scope one Agent's tool surface to its role. Every request carries only the
 * tools the role uses, which keeps the prompt prefix small and stable for
 * provider caches; the matching guard keeps a hidden tool from being called
 * by name or from inside code mode.
 */
export function scopeAgentTools(agentCtx: Context, role: ProjectAgentRole): void {
  agentCtx.on('agent/request', (request: AgentRequestEvent): AgentRequestEvent => ({
    ...request,
    tools: request.tools.filter(tool => toolVisible(role, tool.schema.name)),
  }))
}

export function projectToolGuard(roleOf: (agentId: string) => ProjectAgentRole | undefined): ToolGuard {
  return request => {
    const agentId = request.options.agentId
    if (!agentId) return undefined
    const role = roleOf(agentId)
    if (!role || toolVisible(role, request.name)) return undefined
    return role.kind === 'coordinator'
      ? `${request.name} is not available to the coordinator; dispatch this work to a thread with spawn_thread.`
      : `${request.name} is not available in this thread.`
  }
}
