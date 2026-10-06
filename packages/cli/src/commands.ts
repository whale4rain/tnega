import { skillTools } from '@tnega/coding-agent'
import { resolve } from 'node:path'
import { workspacePrompt } from './workspace-prompt.js'
import { Context, type Plugin } from '@tnega/core'
import type { AgentProfile } from './profile.js'
import {
  agent,
  DurableInbox,
  defineAgent,
  systemPrompt,
  type SystemPromptService,
  type AgentContextBudget,
  type AgentDefinition,
  type AgentInbox,
  type AgentLoop,
  type AgentInput,
  type AgentRunOptions,
  type AgentRunResult,
  type LLMAdapter,
} from '@tnega/agent'
import { createLlmAdapter } from '@tnega/llm'
import { memoryLocal } from '@tnega/memory-local'
import { searchRipgrep } from '@tnega/search-ripgrep'
import { canonicalPath, isSandboxMode, resolveSandboxPolicy, type SandboxMode } from '@tnega/sandbox'
import { sandboxLocal } from '@tnega/sandbox-local'
import { sandboxedExecution } from '@tnega/execution-sandbox'
import { configureSystemShell } from '@tnega/execution'
import { SESSION_FORMAT_VERSION, session } from '@tnega/session'
import { spillLocal } from '@tnega/spill-local'
import { toolSpill } from '@tnega/tool-spill'
import { toolOffice } from '@tnega/tool-office'
import { toolSearch } from '@tnega/tool-search'
import { toolMemory } from '@tnega/tool-memory'
import { runSummary } from '@tnega/run-summary'
import { ptcRuntimeQuickjs, type PtcRuntimeQuickjsConfig } from '@tnega/ptc-runtime-quickjs'
import { toolPtc } from '@tnega/tool-ptc'
import { jobsLocal } from '@tnega/jobs-local'
import { toolJobs } from '@tnega/tool-jobs'
import { GENERAL_SYSTEM_PROMPT } from './work.js'
import {
  builtinTools,
  tools,
  type BuiltinToolsConfig,
  type ToolPolicy,
} from '@tnega/tools'
import {
  effectiveApiKey,
  readSystemConfig,
  resolveLlmEnv,
  systemConfigPath,
} from './config.js'
import { readAgentProfile } from './profile-file.js'
import { defaultRunSessionFile } from './home-paths.js'

export interface RunAgentCommandOptions {
  prompt: string
  cwd?: string
  sessionFile?: string
  configFile?: string
  profile?: string
  model?: string
  baseUrl?: string
  maxTokens?: number
  temperature?: number
  maxTurns?: number
  maxSteps?: number
  allowNetwork?: boolean
  allowShell?: boolean
  /**
   * 本机沙箱模式；缺省按 `allowShell` 推导（`workspace-write` / `read-only`）。
   * `bypass` 是显式选择「不要沙箱」，不是失败后的降级。
   */
  sandboxMode?: SandboxMode
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
}

export interface RunAgentCommandResult {
  run: AgentRunResult
  sessionFile: string
}

export interface LlmEnvConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export { resolveLlmEnv } from './config.js'

export interface AgentRuntimeOptions {
  cwd: string
  sessionFile: string
  profile?: AgentProfile
  llm?: LLMAdapter
  contextWindow?: number
  inbox?: AgentInbox
  allowNetwork?: boolean
  allowShell?: boolean
  /**
   * 本机沙箱的模式。缺省按「有 shell 就至少要能写工作区」推导：`allowShell` 时是
   * `workspace-write`，否则 `read-only`。宿主上没有任何可用后端时 shell 会 fail
   * closed（拒绝执行），而不是悄悄退回非受限执行。
   */
  sandboxMode?: SandboxMode
  maxTurns?: number
  maxSteps?: number
  contextBudget?: AgentContextBudget
  agent?: AgentDefinition
  toolPolicy?: ToolPolicy
  builtinTools?: false | BuiltinToolsConfig
  /** Defaults to enabled with builtin tools; explicitly enable for custom compositions. */
  jobs?: boolean
  /** Defaults to enabled with builtin tools; installs offline user skills. */
  skills?: boolean
  plugins?: readonly Plugin[]
  /** Web per-run agents consume durable steering at model step boundaries. */
  durableInbox?: boolean
  ptc?: { mode?: 'native' | 'both' | 'ptc'; timeoutMs?: number; memoryLimitBytes?: number }
  /** Host-provided runtime assets and limits; independent of model-visible PTC mode. */
  ptcRuntime?: PtcRuntimeQuickjsConfig
}

export interface AgentRuntime {
  root: Context
  inbox?: DurableInbox
  dispose: () => Promise<void>
}

export class CliError extends Error {
  override name = 'CliError'
}


export async function runAgentCommand(
  options: RunAgentCommandOptions,
): Promise<RunAgentCommandResult> {
  const cwd = options.cwd ?? process.cwd()
  const sessionFile = options.sessionFile
    ? resolve(cwd, options.sessionFile)
    : defaultRunSessionFile(cwd, SESSION_FORMAT_VERSION)
  const configFile = options.configFile ?? systemConfigPath()
  const profile = options.profile
    ? await readAgentProfile(options.profile)
    : undefined
  const profileOptions = (profile?.options ?? {}) as Record<string, unknown>
  const systemConfig = await readSystemConfig(configFile)
  const envConfig = resolveLlmEnv(process.env)
  const apiKey = effectiveApiKey(systemConfig)
  if (!apiKey) {
    throw new CliError(
      'missing LLM API key; set TNEGA_API_KEY (or OPENCODE_GO_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY) or configure it in the tnega config file',
    )
  }

  const model = options.model
    ?? profileOptions.model
    ?? envConfig.model
    ?? systemConfig.model
  const profileBaseUrl = typeof profileOptions.baseUrl === 'string'
    ? profileOptions.baseUrl
    : undefined
  const baseUrl = options.baseUrl
    ?? profileBaseUrl
    ?? envConfig.baseUrl
    ?? systemConfig.baseUrl
  const adapter = createLlmAdapter({
    apiKey,
    ...(typeof model === 'string' && model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(protocolFrom(profileOptions) ?? systemConfig.protocol
      ? { protocol: protocolFrom(profileOptions) ?? systemConfig.protocol }
      : {}),
    ...(systemConfig.apiKeyHeader ? { apiKeyHeader: systemConfig.apiKeyHeader } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.maxTokens === undefined && typeof profileOptions.maxTokens === 'number'
      ? { maxTokens: profileOptions.maxTokens }
      : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(systemConfig.temperature !== undefined
      && options.temperature === undefined
      && profileOptions.temperature === undefined
      ? { temperature: systemConfig.temperature }
      : {}),
    ...(options.temperature === undefined
      && typeof profileOptions.temperature === 'number'
      ? { temperature: profileOptions.temperature }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.timeoutMs === undefined && typeof profileOptions.timeoutMs === 'number'
      ? { timeoutMs: profileOptions.timeoutMs }
      : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.maxRetries === undefined && typeof profileOptions.maxRetries === 'number'
      ? { maxRetries: profileOptions.maxRetries }
      : {}),
    ...(options.retryDelayMs !== undefined
      ? { retryDelayMs: options.retryDelayMs }
      : {}),
    ...(options.retryDelayMs === undefined
      && typeof profileOptions.retryDelayMs === 'number'
      ? { retryDelayMs: profileOptions.retryDelayMs }
      : {}),
  })
  const profileRuntimeOptions = runtimeOptionsFromProfile(profileOptions)
  configureSystemShell(systemConfig.shell)
  const context = await createAgentRuntime({
    cwd,
    sessionFile,
    llm: adapter,
    ...(profile ? { profile } : {}),
    ...profileRuntimeOptions,
    ptc: { mode: systemConfig.codeMode ? 'ptc' : 'native' },
    ...(options.allowNetwork !== undefined
      ? { allowNetwork: options.allowNetwork }
      : {}),
    ...(options.allowShell !== undefined ? { allowShell: options.allowShell } : {}),
    ...(options.sandboxMode !== undefined ? { sandboxMode: options.sandboxMode } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
  })
  try {
    const loop = context.root.get('agentLoop') as AgentLoop
    const runOptions: AgentRunOptions = {}
    if (options.maxTurns !== undefined) runOptions.maxTurns = options.maxTurns
    if (options.maxSteps !== undefined) runOptions.maxSteps = options.maxSteps
    const run = await loop({ text: options.prompt }, runOptions)
    return { run, sessionFile }
  } finally {
    await context.dispose()
  }
}

function protocolFrom(
  options: Record<string, unknown>,
): 'anthropic' | 'openai' | undefined {
  return options.protocol === 'anthropic' || options.protocol === 'openai'
    ? options.protocol
    : undefined
}

function runtimeOptionsFromProfile(
  options: Record<string, unknown>,
): Pick<
  AgentRuntimeOptions,
  'allowNetwork' | 'allowShell' | 'sandboxMode' | 'maxTurns' | 'maxSteps' | 'builtinTools' | 'jobs' | 'skills'
> {
  const builtinTools = options.builtinTools === false
    || (options.builtinTools && typeof options.builtinTools === 'object')
    ? options.builtinTools as AgentRuntimeOptions['builtinTools']
    : undefined
  const result: Partial<Pick<
    AgentRuntimeOptions,
    'allowNetwork' | 'allowShell' | 'sandboxMode' | 'maxTurns' | 'maxSteps' | 'builtinTools' | 'jobs' | 'skills'
  >> = {}
  if (options.allowNetwork === true) result.allowNetwork = true
  if (options.allowShell === true) result.allowShell = true
  // profile 可以显式选 `bypass`，这是宿主缺后端时唯一的逃生口 —— 它是显式选择，
  // 不是失败后的静默降级（那仍然禁止）。
  if (isSandboxMode(options.sandboxMode)) result.sandboxMode = options.sandboxMode
  if (typeof options.maxTurns === 'number' && Number.isFinite(options.maxTurns)) {
    result.maxTurns = options.maxTurns
  }
  if (typeof options.maxSteps === 'number' && Number.isFinite(options.maxSteps)) {
    result.maxSteps = options.maxSteps
  }
  if (typeof options.skills === 'boolean') result.skills = options.skills
  if (builtinTools !== undefined) result.builtinTools = builtinTools
  if (typeof options.jobs === 'boolean') result.jobs = options.jobs
  return result
}

export async function createAgentRuntime(
  options: AgentRuntimeOptions,
): Promise<AgentRuntime> {
  const merged: AgentRuntimeOptions = {
    ...(options.profile?.options ?? {}),
    ...options,
    plugins: [...(options.profile?.bundles ?? []), ...(options.plugins ?? [])],
  }
  const root = new Context()
  const fibers: Array<{ dispose: () => Promise<void> }> = []
  const sessionFiber = await root.plugin(session, {
    file: merged.sessionFile,
  })
  fibers.push(sessionFiber)
  const durableInbox = merged.durableInbox ? await DurableInbox.restore(root.get('session')) : undefined
  const toolsFiber = await root.plugin(tools, merged.toolPolicy ?? {})
  const summaryFiber = await root.plugin(runSummary)
  fibers.push(toolsFiber)
  fibers.push(summaryFiber)
  fibers.push(await root.plugin(memoryLocal, { cwd: merged.cwd }))
  fibers.push(await root.plugin(toolMemory, { writeTool: merged.builtinTools !== false }))
  if (merged.builtinTools !== false) {
    // 沙箱缝：composition 层挑 Provider（`sandbox-local`），模型可见的 `shell` 只
    // 认识它脚下的执行边界 —— `sandboxedExecution` 是这条缝的 Consumer，只 import
    // Service Definition。
    fibers.push(await root.plugin(sandboxLocal, { workspaceRoot: canonicalPath(resolve(merged.cwd)) }))
    const sandboxMode: SandboxMode = merged.sandboxMode ?? (merged.allowShell ? 'workspace-write' : 'read-only')
    const builtinConfig: BuiltinToolsConfig = {
      cwd: merged.cwd,
      execution: sandboxedExecution(root, {
        policy: resolveSandboxPolicy({
          mode: sandboxMode,
          workspaceRoot: canonicalPath(resolve(merged.cwd)),
          sessionId: merged.sessionFile,
        }),
      }),
    }
    if (merged.allowNetwork) builtinConfig.allowNetwork = true
    if (merged.allowShell) builtinConfig.allowShell = true
    if (merged.builtinTools && typeof merged.builtinTools === 'object') {
      Object.assign(builtinConfig, merged.builtinTools)
    }
    const builtinToolsFiber = await root.plugin(builtinTools, builtinConfig)
    fibers.push(builtinToolsFiber)

    // 搜索与溢出是两条能力缝：composition 层挑 Provider，模型可见的工具只认识
    // ctx.search，工具结果的上限只认识 ctx.spillStore。
    fibers.push(await root.plugin(searchRipgrep, { cwd: merged.cwd }))
    fibers.push(await root.plugin(toolSearch, { cwd: merged.cwd }))
    fibers.push(await root.plugin(spillLocal, { cwd: merged.cwd }))
    fibers.push(await root.plugin(toolSpill))
    fibers.push(await root.plugin(toolOffice, { cwd: merged.cwd }))
  }
  if (merged.skills ?? (merged.builtinTools !== false)) {
    fibers.push(await root.plugin(skillTools, { cwd: merged.cwd }))
  }
  // Wire the prompt-assembly seam into the default composition: the system
  // prompt is assembled from registered sections and every executable tool is
  // exposed as a schema provider, so `assemble().text`/`tools` are the single
  // path the loop reads when a systemPrompt service is present.
  const promptFiber = await root.plugin(systemPrompt)
  fibers.push(promptFiber)
  fibers.push(await root.plugin(workspacePrompt, { workspace: merged.cwd }))
  const promptService = root.get('systemPrompt') as {
    registerTools(
      provider: () => readonly {
        name: string
        description: string
        parameters?: Record<string, unknown>
      }[],
    ): () => void
  } | undefined
  const toolRegistry = root.get('tools') as {
    list(): ReadonlyArray<{
      schema: {
        name: string
        description: string
        parameters?: Record<string, unknown>
      }
    }>
  } | undefined
  let disposePromptTools: (() => void) | undefined
  if (promptService && toolRegistry) {
    disposePromptTools = promptService.registerTools(() => (
      toolRegistry.list().map(tool => tool.schema)
    ))
  }
  if (merged.agent) {
    const definitionFiber = await root.plugin(defineAgent(merged.agent), {
      ...(merged.llm ? { llm: merged.llm } : {}),
      ...(merged.contextWindow !== undefined ? { contextWindow: merged.contextWindow } : {}),
      ...(merged.maxTurns !== undefined ? { maxTurns: merged.maxTurns } : {}),
      ...(merged.maxSteps !== undefined ? { maxSteps: merged.maxSteps } : {}),
      ...(merged.inbox ? { inbox: merged.inbox } : {}),
      ...(merged.contextBudget ? { contextBudget: merged.contextBudget } : {}),
    })
    fibers.push(definitionFiber)
  } else {
    const agentConfig: {
      llm?: LLMAdapter
      contextWindow?: number
      maxTurns?: number
      maxSteps?: number
      inbox?: AgentInbox
      contextBudget?: AgentContextBudget
      claimNextStep?: () => Promise<readonly AgentInput[]>
    } = {}
    if (merged.llm) agentConfig.llm = merged.llm
    if (merged.contextWindow !== undefined) agentConfig.contextWindow = merged.contextWindow
    if (merged.maxTurns !== undefined) agentConfig.maxTurns = merged.maxTurns
    if (merged.maxSteps !== undefined) agentConfig.maxSteps = merged.maxSteps
    if (merged.inbox) agentConfig.inbox = merged.inbox
    if (merged.contextBudget) agentConfig.contextBudget = merged.contextBudget
    if (durableInbox) agentConfig.claimNextStep = () => durableInbox.claimNextStep()
    const agentFiber = await root.plugin(agent, agentConfig)
    fibers.push(agentFiber)
  }
  try {
    if (merged.jobs ?? (merged.builtinTools !== false)) {
      fibers.push(await root.plugin(jobsLocal))
      fibers.push(await root.plugin(toolJobs, { resolveSession: () => root.get('session') }))
    }
    for (const plugin of merged.plugins ?? []) {
      const fiber = await root.plugin(plugin)
      fibers.push(fiber)
    }
    if (!merged.agent && merged.builtinTools !== false && !root.get('agentDefinition')) {
      const prompts: SystemPromptService = root.get('systemPrompt')
      root.effect(() => prompts.registerSection({ name: 'default:persona', order: 0, content: GENERAL_SYSTEM_PROMPT }))
    }
    fibers.push(await root.plugin(ptcRuntimeQuickjs, {
      ...merged.ptcRuntime,
      ...(merged.ptc?.timeoutMs !== undefined ? { timeoutMs: merged.ptc.timeoutMs } : {}),
      ...(merged.ptc?.memoryLimitBytes !== undefined ? { memoryLimitBytes: merged.ptc.memoryLimitBytes } : {}),
    }))
    fibers.push(await root.plugin(toolPtc, {
      mode: merged.ptc?.mode ?? 'native',
      resolveSession: () => root.get('session'),
    }))
  } catch (error) {
    await root.fiber.dispose()
    throw error
  }
  return {
    root,
    ...(durableInbox ? { inbox: durableInbox } : {}),
    dispose: async () => {
      disposePromptTools?.()
      // The composition may mount more plugins after construction (for example Web answerers).
      await root.fiber.dispose()
    },
  }
}

export function formatAgentRun(result: RunAgentCommandResult): string {
  const output = result.run.output.trim()
  const lines: string[] = []
  if (output) lines.push(output)
  lines.push(`finish ${result.run.finishReason}`)
  lines.push(`steps ${result.run.steps.length}`)
  lines.push(`session ${result.sessionFile}`)
  return lines.join('\n')
}
