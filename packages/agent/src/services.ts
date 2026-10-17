import type { Context } from '@tnega/core'
import type { AgentDefinition } from './definition.js'
import type { AgentRegistry } from './live.js'
import type { LlmService } from './llm-service.js'
import type { SystemPromptService } from './prompt.js'
import type { AgentInbox, AgentService } from './service.js'
import type { AgentLoop } from './types.js'

/**
 * The `ctx` keys this package provides. Every one is registered with
 * `ctx.provide`, so the declaration is the only typing they get — a missing
 * entry here is what makes consumers reach for `ctx.get(...) as T`.
 *
 * `agentDefinition` and `agentSystem` are absent until a definition mounts,
 * which is why they are optional in the map rather than in the type.
 */
declare module '@tnega/core' {
  interface ServiceMap {
    agent: AgentService
    agentLoop: AgentLoop
    inbox: AgentInbox
    agents: AgentRegistry
    systemPrompt: SystemPromptService
    agentDefinition: AgentDefinition | undefined
    agentSystem: string | undefined
    agentScope: Context
    llm: LlmService
  }
}
