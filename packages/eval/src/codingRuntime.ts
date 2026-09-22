import { defineAgent, type AgentLoop, type LLMAdapter } from '@tnega/agent'
import { CODING_SYSTEM_PROMPT, createCodingAgentPlugin } from '@tnega/coding-agent'
import { Context } from '@tnega/core'
import { session } from '@tnega/session'
import { searchRipgrep } from '@tnega/search-ripgrep'
import { toolSearch } from '@tnega/tool-search'
import { builtinTools, tools, type ToolPolicy } from '@tnega/tools'

import type { CodingEvalConfig } from './types.js'

export interface CodingEvalRuntimeOptions {
  cwd: string
  sessionFile: string
  config: CodingEvalConfig
  toolPolicy: ToolPolicy
  allowShell?: boolean
  allowNetwork?: boolean
}

export interface CodingEvalRuntime {
  root: Context
  loop: AgentLoop
  dispose(): Promise<void>
}

export async function createCodingEvalRuntime(
  options: CodingEvalRuntimeOptions,
): Promise<CodingEvalRuntime> {
  const root = new Context()
  await root.plugin(session, { file: options.sessionFile })
  await root.plugin(tools, options.toolPolicy)
  await root.plugin(builtinTools, {
    cwd: options.cwd,
    allowNetwork: options.allowNetwork ?? false,
    allowShell: options.allowShell ?? false,
    disabled: [],
  })
  // 搜索缝：composition 层挑 Provider。
  await root.plugin(searchRipgrep, { cwd: options.cwd })
  await root.plugin(toolSearch, { cwd: options.cwd })

  const agentConfig: {
    llm: LLMAdapter
    maxTurns?: number
    maxSteps?: number
  } = { llm: options.config.llm }
  if (options.config.agent?.maxTurns !== undefined) {
    agentConfig.maxTurns = options.config.agent.maxTurns
  }
  if (options.config.agent?.maxSteps !== undefined) {
    agentConfig.maxSteps = options.config.agent.maxSteps
  }
  await root.plugin(defineAgent({
    name: 'coding-eval',
    system: options.config.agent?.systemPrompt ?? CODING_SYSTEM_PROMPT,
  }), agentConfig)

  const codingOptions: {
    cwd: string
    skills: boolean
    planTools: boolean
    mcp: boolean
    registerAgent: boolean
    planPrompt?: string
  } = {
    cwd: options.cwd,
    skills: options.config.coding?.skills ?? false,
    planTools: options.config.coding?.planTools ?? true,
    mcp: false,
    registerAgent: false,
  }
  if (options.config.coding?.planPrompt !== undefined) {
    codingOptions.planPrompt = options.config.coding.planPrompt
  }
  await root.plugin(createCodingAgentPlugin(codingOptions))

  const loop = root.get('agentLoop') as AgentLoop
  return {
    root,
    loop,
    dispose: async () => {
      await root.fiber.dispose()
    },
  }
}
