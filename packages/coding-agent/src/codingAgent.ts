import type { Context, Plugin } from '@tnega/core'
import { defineAgent, HUMAN_COMMUNICATION_PROMPT, type LLMAdapter } from '@tnega/agent'
import type { ModelMessage, SessionMode } from '@tnega/session'
import { resolve } from 'node:path'
import type { ToolDefinition, ToolsService } from '@tnega/tools'
import { connectMcpServers, type McpRuntime } from './mcp.js'
import { generatePlan } from './plan.js'
import { skillTools, type SkillsService } from './skills.js'
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

export const CODING_SYSTEM_PROMPT = `You are Tnega, a coding agent working in the user's repository.

Work in small verified steps: read the code before you change it, keep the change reviewable, and run the check that proves it — tests, typecheck or a command. Keep the repository's existing conventions and leave unrelated code alone. Finish the authorized task rather than a subset of it; if part is impossible, say which part and why.

Report the outcome, the files that changed, the checks you ran with their result, and anything still unresolved. Summarize command output instead of pasting it.

For web frontends, check your changes in the browser when browser_* tools are available:
- Start the dev server with job_start (tool shell, wait_for_url_ms 15000; plain shell waits for exit) and open the URL it prints with browser_navigate.
- Read the page with browser_snapshot, interact by ref, and use browser_take_screenshot to judge layout and styling.
- Check browser_console_messages and browser_network_requests for errors before calling the work done.

In plan mode, produce a plan only. Do not edit files or execute the plan.

${HUMAN_COMMUNICATION_PROMPT}`

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
      if (skillsEnabled) {
        const existing = ctx.get('skills') as SkillsService | undefined
        if (existing && existing.cwd !== resolve(cwd)) throw new Error('skills workspace mismatch')
        if (!existing) await ctx.plugin(skillTools, { cwd })
      }
      let skillCount = 0
      let mcpServers = 0
      let mcpTools = 0

      if (skillsEnabled) {
        skillCount = 4
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
        executeTool: async (name, input) => {
          const registry = ctx.get('tools') as ToolsService
          const result = await registry.execute(name, input)
          if (!result.ok) throw new Error(result.error?.message ?? `tool failed: ${name}`)
          return result.output
        },
        tools: service.tools.list(),
        ...(mode ? { mode } : {}),
        ...(setMode ? { setMode } : {}),
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
