import type { Context, Plugin } from '@tnega/core'
import { defineAgent, type LLMAdapter } from '@tnega/agent'
import type { ModelMessage, SessionMode } from '@tnega/session'
import type { ToolDefinition } from '@tnega/tools'
import { connectMcpServers, type McpRuntime } from './mcp.js'
import { generatePlan } from './plan.js'
import { listSkills, skillReadTool, skillTool } from './skills.js'
import { createSlashRegistry, type SlashCommandResult } from './slash.js'
import type { CodingSurvey, Plan, SlashCommand, SlashSuggestion } from './types.js'

export interface CodingAgentOptions {
  cwd: string
  mode?: SessionMode
  setMode?: (mode: SessionMode) => void | Promise<void>
  skills?: boolean
  mcp?: boolean
  planTools?: boolean
  registerAgent?: boolean
  systemPrompt?: string
  planPrompt?: string
}

export interface CodingService {
  generatePlan(adapter: LLMAdapter, messages: readonly ModelMessage[], signal?: AbortSignal): Promise<Plan>
  commands(): SlashCommand[]
  runCommand(name: string, args: string[]): Promise<SlashCommandResult>
  suggestCommand(name: string): Promise<SlashSuggestion[]>
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

In plan mode, produce a plan only. Do not edit files or execute the plan.`

export function createCodingAgentPlugin(
  options: CodingAgentOptions,
): Plugin {
  const cwd = options.cwd
  const skillsEnabled = options.skills ?? true
  const mcpEnabled = options.mcp ?? true
  const mode = options.mode
  const setMode = options.setMode
  const registerAgent = options.registerAgent ?? true

  return {
    name: 'coding-agent',
    inject: ['session', 'tools'],
    apply: async (ctx: Context) => {
      const service = dynamic(ctx)
      const tools: ToolDefinition[] = []
      const skillEntries = await listSkills(cwd)
      let skillCount = 0
      let mcpServers = 0
      let mcpTools = 0

      if (skillsEnabled) {
        tools.push(await skillTool(cwd))
        tools.push(await skillReadTool(cwd))
        skillCount = 2
      }
      let mcpRuntime: McpRuntime | undefined
      if (mcpEnabled) {
        mcpRuntime = await connectMcpServers(cwd, () => {
          mcpTools += 1
        })
        mcpServers = mcpRuntime.surveys.length
        for (const survey of mcpRuntime.surveys) {
          if (survey.status === 'failed') {
            throw new Error(`mcp server ${survey.name} failed: ${survey.error ?? 'unknown'}`)
          }
        }
        tools.push(...mcpRuntime.tools)
        ctx.fiber.effect(() => () => {
          void mcpRuntime?.dispose()
        }, 'coding:dispose-mcp')
      }
      for (const tool of tools) {
        service.tools.register(tool)
      }

      const slash = createSlashRegistry()
      const slashContext = (): Parameters<typeof slash.run>[2] => ({
        cwd,
        tools: service.tools.list(),
        ...(mode ? { mode } : {}),
        ...(setMode ? { setMode } : {}),
        ...(skillEntries.length ? { skills: skillEntries } : {}),
        ...(mcpRuntime ? {
          mcp: {
            surveys: mcpRuntime.surveys,
            tools: mcpRuntime.tools,
          },
        } : {}),
      })
      const survey = (): CodingSurvey => ({
        agentType: 'coding',
        mode: mode ?? 'auto',
        planTools: 0,
        skillsEnabled,
        skills: skillCount,
        mcpEnabled,
        mcpServers,
        mcpTools,
      })

      ctx.provide('coding', {
        generatePlan: (adapter, messages, signal) =>
          generatePlan(adapter, messages, signal, options.planPrompt),
        commands: () => slash.list(),
        runCommand: async (name, args) => slash.run(name, args, slashContext()),
        suggestCommand: async (name) => slash.suggest(name, slashContext()),
        survey,
      } satisfies CodingService)

      if (registerAgent) {
        const systemPrompt = options.systemPrompt ?? CODING_SYSTEM_PROMPT
        await ctx.plugin(defineAgent({
          name: 'coding',
          version: '0.1.0',
          system: systemPrompt,
          tools: [],
        }))
      }
    },
  }
}
