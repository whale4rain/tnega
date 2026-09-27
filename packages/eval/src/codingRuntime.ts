import { defineAgent, type AgentLoop, type LLMAdapter } from '@tnega/agent'
import { CODING_SYSTEM_PROMPT, createCodingAgentPlugin } from '@tnega/coding-agent'
import { Context } from '@tnega/core'
import type { ExecutionProvider } from '@tnega/execution'
import { memoryLocal } from '@tnega/memory-local'
import { session } from '@tnega/session'
import { searchRipgrep } from '@tnega/search-ripgrep'
import { canonicalPath, resolveSandboxPolicy } from '@tnega/sandbox'
import { sandboxLocal } from '@tnega/sandbox-local'
import { sandboxedExecution } from '@tnega/execution-sandbox'
import { spillLocal } from '@tnega/spill-local'
import { toolSpill } from '@tnega/tool-spill'
import { toolSearch } from '@tnega/tool-search'
import { toolMemory } from '@tnega/tool-memory'
import { builtinTools, tools, type ToolPolicy } from '@tnega/tools'

import type { CodingEvalConfig } from './types.js'

export interface CodingEvalRuntimeOptions {
  cwd: string
  sessionFile: string
  config: CodingEvalConfig
  toolPolicy: ToolPolicy
  allowShell?: boolean
  allowNetwork?: boolean
  /** 真正落进程的实现；测试与宿主可替换。沙箱包装仍然生效。 */
  execution?: ExecutionProvider
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
  await root.plugin(memoryLocal, { cwd: options.cwd })
  await root.plugin(toolMemory)
  // 沙箱缝：Provider 由 composition 挑，Consumer 只认识 Service Definition。
  await root.plugin(sandboxLocal, { workspaceRoot: canonicalPath(options.cwd) })
  await root.plugin(builtinTools, {
    cwd: options.cwd,
    allowNetwork: options.allowNetwork ?? false,
    allowShell: options.allowShell ?? false,
    disabled: [],
    // 评测同样跑在沙箱里：`TaskPermissions.shell.enabled` 决定的是能不能用 shell，
    // 不是能不能无限制地用。没有可用后端时 shell 会 fail closed。
    execution: sandboxedExecution(root, {
      ...(options.execution !== undefined ? { inner: options.execution } : {}),
      policy: resolveSandboxPolicy({
        mode: options.allowShell === true ? 'workspace-write' : 'read-only',
        workspaceRoot: canonicalPath(options.cwd),
        sessionId: options.sessionFile,
      }),
    }),
  })
  // 搜索缝：composition 层挑 Provider。
  await root.plugin(searchRipgrep, { cwd: options.cwd })
  await root.plugin(toolSearch, { cwd: options.cwd })
  await root.plugin(spillLocal, { cwd: options.cwd })
  await root.plugin(toolSpill)

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
