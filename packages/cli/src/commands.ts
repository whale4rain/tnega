import { resolve } from 'node:path'
import { createAgentRuntime, type AgentRuntimeOptions } from '@tnega/runtime'
import type { AgentRunOptions, AgentRunResult } from '@tnega/agent'
import { createLlmAdapter } from '@tnega/llm'
import { isSandboxMode, type SandboxMode } from '@tnega/sandbox'
import { configureNetwork, configureSystemShell } from '@tnega/execution'
import { SESSION_FORMAT_VERSION } from '@tnega/session'
import {
  effectiveApiKey,
  effectiveLlmConfig,
  readSystemConfig,
  resolveLlmEnv,
  systemConfigPath,
} from '@tnega/config'
import { readAgentProfile } from '@tnega/profile'
import { defaultRunSessionFile } from '@tnega/home'

export { createAgentRuntime }
export type { AgentRuntime, AgentRuntimeOptions } from '@tnega/runtime'

/** Steps one `tnega run` turn may take unless `--max-steps` says otherwise. */
export const RUN_MAX_STEPS = 64

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
  /** How strictly a file write must match what this Session already read. */
  fsGuard?: 'off' | 'warn' | 'enforce'
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

export { resolveLlmEnv } from '@tnega/config'

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
  // The window the route actually has: auto compaction needs it, and a run
  // without one compacts against a generic default instead of its own model.
  const contextWindow = effectiveLlmConfig(systemConfig, process.env, options.model).contextWindow
  const profileRuntimeOptions = runtimeOptionsFromProfile(profileOptions)
  configureSystemShell(systemConfig.shell)
  // The saved proxy, for http_get and for sandboxed commands' allowed traffic.
  configureNetwork({ ...systemConfig.network })
  const context = await createAgentRuntime({
    cwd,
    sessionFile,
    llm: adapter,
    ...(profile ? { profile } : {}),
    ...profileRuntimeOptions,
    ptc: { mode: systemConfig.codeMode ? 'ptc' : 'native' },
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(options.allowNetwork !== undefined
      ? { allowNetwork: options.allowNetwork }
      : {}),
    ...(options.allowShell !== undefined ? { allowShell: options.allowShell } : {}),
    ...(options.sandboxMode !== undefined ? { sandboxMode: options.sandboxMode } : {}),
    // Command network access saved in Settings applies to `tnega run` too.
    ...(systemConfig.sandbox?.network ? { sandboxNetwork: systemConfig.sandbox.network } : {}),
    // The flag wins; otherwise the guard saved in Settings applies here too.
    ...((options.fsGuard ?? systemConfig.fsGuard) !== undefined ? { fsGuard: options.fsGuard ?? systemConfig.fsGuard } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    // Computer use only when turned on in Settings; off also overrides a profile.
    computer: systemConfig.computerUse
      ? {
          ...(systemConfig.computerDriverPath ? { driverPath: systemConfig.computerDriverPath } : {}),
          ...(systemConfig.computerMaxScreenshots !== undefined ? { maxScreenshots: systemConfig.computerMaxScreenshots } : {}),
        }
      : false,
  })
  try {
    const loop = context.root.get('agentLoop')
    const runOptions: AgentRunOptions = {}
    if (options.maxTurns !== undefined) runOptions.maxTurns = options.maxTurns
    // Pinned explicitly: the runtime mounts the loop guard, whose backstop would
    // otherwise lift this one-shot budget from 64 steps to a long-running one.
    // A script that needs more says so with --max-steps.
    runOptions.maxSteps = options.maxSteps ?? RUN_MAX_STEPS
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

export function formatAgentRun(result: RunAgentCommandResult): string {
  const output = result.run.output.trim()
  const lines: string[] = []
  if (output) lines.push(output)
  lines.push(`finish ${result.run.finishReason}`)
  lines.push(`steps ${result.run.steps.length}`)
  lines.push(`session ${result.sessionFile}`)
  return lines.join('\n')
}
