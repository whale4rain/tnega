import type { Context, Plugin } from '@tnega/core'
import type { ModelMessage } from '@tnega/session'
import type { ToolDefinition } from '@tnega/tools'

import { agent, AgentService, type AgentConfig } from './service.js'
import type { AgentHooks, AgentInput, AgentLoop } from './types.js'

export type AgentDefinitionHooks = AgentHooks

export interface AgentDefinition {
  name: string
  version?: string
  system?: string | ((ctx: Context) => string)
  tools?: readonly ToolDefinition[]
  loop?: AgentLoop
  hooks?: AgentDefinitionHooks
}

export interface DefineAgentConfig extends Partial<Pick<AgentConfig, 'llm' | 'maxTurns' | 'maxSteps'>> {
  [key: string]: unknown
}

function resolveSystemPrompt(
  ctx: Context,
  system: string | ((ctx: Context) => string) | undefined,
): string | undefined {
  if (!system) return undefined
  return typeof system === 'function' ? system(ctx) : system
}

function withSystemPrompt(
  input: AgentInput | undefined,
  system: string | undefined,
): AgentInput | undefined {
  if (!system) return input
  const messages: ModelMessage[] = [
    { role: 'system', content: system },
    ...(input?.messages ?? []),
  ]
  if (input?.text) messages.push({ role: 'user', content: input.text })
  return { ...(input ?? {}), messages }
}

export function defineAgent(
  definition: AgentDefinition,
): Plugin {
  const name = definition.name.trim()
  if (!name) throw new TypeError('agent definition requires a non-empty name')

  return {
    name: `agent:${name}`,
    inject: ['session', 'tools'],
    apply: async (ctx: Context, config: DefineAgentConfig = {}) => {
      const dynamic = ctx as unknown as {
        tools: { register(tool: ToolDefinition): () => void }
      }
      const system = resolveSystemPrompt(ctx, definition.system)
      let agentService: AgentService | undefined

      if (definition.loop) {
        const loop: AgentLoop = async (input, options) => {
          await definition.hooks?.beforeRun?.(input ?? {}, options ?? {})
          const result = await definition.loop!(
            withSystemPrompt(input, system),
            options,
          )
          await definition.hooks?.afterRun?.(result, options ?? {})
          return result
        }
        ctx.provide('agentLoop', loop)
      } else {
        const agentConfig: AgentConfig = {}
        if (definition.hooks) agentConfig.hooks = definition.hooks
        if (config.llm) agentConfig.llm = config.llm
        if (config.maxTurns !== undefined) agentConfig.maxTurns = config.maxTurns
        if (config.maxSteps !== undefined) agentConfig.maxSteps = config.maxSteps
        const agentFiber = ctx.plugin(agent, agentConfig)
        await agentFiber
        agentService = ctx.reflect.get('agent') as AgentService
        if (system) agentService.inbox.inject('agentSystem', system)
      }

      for (const tool of definition.tools ?? []) {
        dynamic.tools.register(tool)
      }

      ctx.provide('agentDefinition', definition)
      ctx.provide('agentSystem', system)
      ctx.emit('agent/definition', {
        name,
        version: definition.version,
        system,
        toolCount: (definition.tools ?? []).length,
      })
    },
  }
}
