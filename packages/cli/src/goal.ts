import { randomUUID } from 'node:crypto'
import type { AgentRegistry } from '@tnega/agent'
import type { Context } from '@tnega/core'
import type { SessionLog } from '@tnega/session'
import type { ToolsService } from '@tnega/tools'

export type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked'

export interface GoalState {
  id: string
  objective: string
  status: GoalStatus
  rounds: number
  maxRounds: number
  detail?: string
}

function goalPayload(value: unknown): GoalState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== 'goal/change' || typeof record.id !== 'string'
    || typeof record.objective !== 'string'
    || (record.status !== 'active' && record.status !== 'paused'
      && record.status !== 'complete' && record.status !== 'blocked')
    || typeof record.rounds !== 'number' || typeof record.maxRounds !== 'number') return undefined
  return {
    id: record.id,
    objective: record.objective,
    status: record.status,
    rounds: record.rounds,
    maxRounds: record.maxRounds,
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
  }
}

export async function readGoal(log: SessionLog): Promise<GoalState | undefined> {
  const events = await log.read()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'meta') continue
    const payload = event.payload as Record<string, unknown>
    if (payload.kind === 'goal/clear') return undefined
    const goal = goalPayload(payload)
    if (goal) return goal
  }
  return undefined
}

export async function writeGoal(log: SessionLog, goal: GoalState): Promise<void> {
  await log.append('meta', { kind: 'goal/change', ...goal })
  await log.flush()
}

export async function createGoal(log: SessionLog, objective: string): Promise<GoalState> {
  const current = await readGoal(log)
  if (current?.status === 'active') throw new Error('pause or complete the current goal first')
  const goal: GoalState = {
    id: randomUUID(), objective: objective.trim(), status: 'active', rounds: 0, maxRounds: 5,
  }
  if (!goal.objective) throw new Error('goal objective is required')
  await writeGoal(log, goal)
  return goal
}

export async function changeGoal(log: SessionLog, status: GoalStatus, detail?: string): Promise<GoalState> {
  const current = await readGoal(log)
  if (!current) throw new Error('no goal in this session')
  if (current.status === 'complete') throw new Error('completed goal cannot be changed')
  const next: GoalState = {
    ...current,
    status,
    ...(status === 'active' && current.rounds >= current.maxRounds
      ? { maxRounds: current.rounds + 5 } : {}),
    ...(detail ? { detail } : {}),
  }
  await writeGoal(log, next)
  return next
}

export const goalTools = {
  name: 'goal-tools',
  inject: ['agents', 'tools'],
  apply(ctx: Context): void {
    const registry = ctx.get('agents') as AgentRegistry
    const tools = ctx.get('tools') as ToolsService
    tools.register({
      schema: {
        name: 'get_goal',
        description: 'Read the current persistent goal and remaining automatic rounds.',
        parameters: { type: 'object', properties: {} },
      },
      async execute(_input, options) {
        const agent = options.agentId ? registry.get(options.agentId) : undefined
        if (!agent) throw new Error('goal tool requires a live Agent')
        return await readGoal(agent.session) ?? '(no goal)'
      },
    })
    tools.register({
      schema: {
        name: 'update_goal',
        description: 'Mark the current goal complete, paused, or blocked. Complete it only when the objective is actually achieved. If blocked, explain the concrete obstacle.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['complete', 'paused', 'blocked'] },
            detail: { type: 'string' },
          },
          required: ['status'],
        },
      },
      async execute(input, options) {
        const agent = options.agentId ? registry.get(options.agentId) : undefined
        if (!agent) throw new Error('goal tool requires a live Agent')
        const value = input && typeof input === 'object' && !Array.isArray(input)
          ? input as Record<string, unknown> : {}
        if (value.status !== 'complete' && value.status !== 'paused' && value.status !== 'blocked') {
          throw new TypeError('status must be complete, paused, or blocked')
        }
        return changeGoal(agent.session, value.status,
          typeof value.detail === 'string' ? value.detail : undefined)
      },
    })
  },
}
