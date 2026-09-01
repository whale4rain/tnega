import type { Context, Plugin } from '@tnega/core'
import { defineAgent, type LLMAdapter } from '@tnega/agent'
import type { ModelMessage, SessionMode } from '@tnega/session'
import type { ToolDefinition } from '@tnega/tools'
import { connectMcpServers } from './mcp.js'
import { generatePlan } from './plan.js'
import { skillReadTool, skillTool } from './skills.js'
import { createSlashRegistry, type SlashCommandResult } from './slash.js'
import type { CodingSurvey, Plan, SlashCommand } from './types.js'

export interface CodingAgentOptions {
  cwd: string
  mode?: SessionMode
  skills?: boolean
  mcp?: boolean
  planTools?: boolean
  registerAgent?: boolean
}

export interface CodingService {
  generatePlan(adapter: LLMAdapter, messages: readonly ModelMessage[], signal?: AbortSignal): Promise<Plan>
  commands(): SlashCommand[]
  runCommand(name: string, args: string[]): Promise<SlashCommandResult>
  survey(): CodingSurvey
}

type DynamicContext = Context & {
  tools: {
    register(tool: ToolDefinition): () => void
    list(): readonly ToolDefinition[]
  }
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

export const CODING_SYSTEM_PROMPT = `You are Tnega, a coding agent running in a workspace session.

You work iteratively in the user's repository:
- Inspect the workspace before editing when the task is unclear.
- Make small, reviewable changes and verify them with tests or commands when appropriate.
- Report exact file paths and command output in your final answer.
- Keep the user's existing code conventions and do not rewrite unrelated code.

When a plan is present, follow it and keep every item's status updated with the plan tools.`

function planToolDefinitions(): ToolDefinition[] {
  return [
    {
      schema: {
        name: 'plan_execute_mark',
        description: 'Mark one plan item as pending, done, or failed while executing the plan.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'plan item id, e.g. plan-1' },
            status: {
              type: 'string',
              enum: ['pending', 'done', 'failed'],
              description: 'new status for the item',
            },
          },
          required: ['id', 'status'],
        },
      },
      execute: (input) => {
        const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
        const id = typeof record.id === 'string' ? record.id : ''
        const status = typeof record.status === 'string' ? record.status : ''
        if (!id) throw new TypeError('id is required')
        if (status !== 'pending' && status !== 'done' && status !== 'failed') {
          throw new TypeError(`invalid status: ${status}`)
        }
        return { id, status }
      },
    },
    {
      schema: {
        name: 'plan_execute_result',
        description: 'Report the final result and status of the current plan execution.',
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['done', 'failed'],
              description: 'overall execution status',
            },
            summary: { type: 'string', description: 'what was completed or blocked' },
          },
          required: ['status'],
        },
      },
      execute: (input) => {
        const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
        const status = typeof record.status === 'string' ? record.status : ''
        const summary = typeof record.summary === 'string' ? record.summary : undefined
        if (status !== 'done' && status !== 'failed') {
          throw new TypeError(`invalid status: ${status}`)
        }
        return {
          status,
          ...(summary ? { summary } : {}),
        }
      },
    },
  ]
}

export function createCodingAgentPlugin(
  options: CodingAgentOptions,
): Plugin {
  const cwd = options.cwd
  const skillsEnabled = options.skills ?? true
  const mcpEnabled = options.mcp ?? true
  const planToolsEnabled = options.planTools ?? true
  const mode = options.mode
  const registerAgent = options.registerAgent ?? true

  return {
    name: 'coding-agent',
    inject: ['session', 'tools'],
    apply: async (ctx: Context) => {
      const service = dynamic(ctx)
      const tools: ToolDefinition[] = []
      const planTools = planToolsEnabled ? planToolDefinitions() : []
      tools.push(...planTools)
      let skills = 0
      let mcpServers = 0
      let mcpTools = 0

      if (skillsEnabled) {
        tools.push(await skillTool(cwd))
        tools.push(await skillReadTool(cwd))
        skills = 2
      }
      if (mcpEnabled) {
        const runtime = await connectMcpServers(cwd, () => {
          mcpTools += 1
        })
        mcpServers = runtime.surveys.length
        for (const survey of runtime.surveys) {
          if (survey.status === 'failed') {
            throw new Error(`mcp server ${survey.name} failed: ${survey.error ?? 'unknown'}`)
          }
        }
        tools.push(...runtime.tools)
        ctx.fiber.effect(() => () => {
          void runtime.dispose()
        }, 'coding:dispose-mcp')
      }
      for (const tool of tools) {
        service.tools.register(tool)
      }

      const slash = createSlashRegistry()
      const survey = (): CodingSurvey => ({
        agentType: 'coding',
        mode: mode ?? 'auto',
        planTools: planTools.length,
        skillsEnabled,
        skills,
        mcpEnabled,
        mcpServers,
        mcpTools,
      })

      ctx.provide('coding', {
        generatePlan,
        commands: () => slash.list(),
        runCommand: async (name, args) => slash.run(name, args, {
          cwd,
          tools: service.tools.list(),
          ...(mode ? { mode } : {}),
        }),
        survey,
      } satisfies CodingService)

      if (registerAgent) {
        await ctx.plugin(defineAgent({
          name: 'coding',
          version: '0.1.0',
          system: CODING_SYSTEM_PROMPT,
          tools: [],
        }))
      }
    },
  }
}
