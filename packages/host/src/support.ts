export { workspaceParam } from '@tnega/web-kit'

import { browserPlaywright, type PlaywrightBrowserHost } from '@tnega/browser-playwright'
import { llmAuthOptions } from '@tnega/auth-chatgpt'
import type { LLMAdapter } from '@tnega/agent'
import { availableModels, effectiveApiKey, effectiveLlmConfig, readSystemConfig, type EffectiveLlmConfig, type SystemConfig } from '@tnega/config'
import { Context, type Plugin } from '@tnega/core'
import { createLlmAdapter, modelCapabilities, openaiCompatAdapter } from '@tnega/llm'
import { PERMISSION_NOTICE_NAME, pendingPermission, type ModelSelection } from '@tnega/run-settings'
import type { HotPluginHost, PluginWorkshop } from '@tnega/plugin-host'
import type { PermissionMode } from '@tnega/approval-host'
import { SessionLog, isModelAttachment, type ModelAttachment, type ModelMessage } from '@tnega/session'
import { readSessionSummary, sessionFile } from '@tnega/session-store'
import { toolBrowser } from '@tnega/tool-browser'
import { sessionSearchSqlite, type SqliteSessionIndex } from '@tnega/session-search-sqlite'
import { toolSessionSearch } from '@tnega/tool-session-search'
import { defaultWorkspace } from '@tnega/home'
import { ProcessRegistry } from '@tnega/tools'
import { resolve } from 'node:path'

export const MAX_RUN_ATTACHMENTS = 8
export const MAX_RUN_BODY_BYTES = 24 * 1024 * 1024
// Independent of the automatic budget's retain ratio on purpose: a manual
// compaction whose surface fits entirely under this budget falls back to
// shadowing the whole surface (`keep` defaults to 0), so raising this value
// past the surface size changes manual compaction from "keep the tail" to
// "summarize everything". Keep it a deliberate choice, not a derived one.
export const KEEP_RECENT_TOKENS = 20_000

/**
 * Host-level plugins every run mounts: the hot profile, the dev workshop, and
 * session search over the workspaces the app lists.
 */
export function hostPlugins(
  context: { hotPlugins?: HotPluginHost; pluginWorkshop?: PluginWorkshop; configFile?: string; sessionIndex?: SqliteSessionIndex },
  workspace: string,
): Plugin[] {
  const index = context.sessionIndex
  return [
    ...(context.hotPlugins ? [context.hotPlugins.plugin] : []),
    ...(context.pluginWorkshop ? [context.pluginWorkshop.plugin] : []),
    ...(index ? [
      { name: 'session-search', apply: (ctx: Context) => { ctx.plugin(sessionSearchSqlite, { index }) } },
      toolSessionSearch({ workspaces: () => knownWorkspaces(context, workspace) }),
    ] : []),
  ]
}

/** The workspaces the sidebar lists, plus the scratch folder and the run's own. */
async function knownWorkspaces(context: { configFile?: string }, workspace: string): Promise<string[]> {
  const config = await readSystemConfig(context.configFile)
  return [workspace, ...(config.workspaces ?? []), defaultWorkspace()]
}

export function processesFor(
  context: { processes: Map<string, ProcessRegistry> },
  workspace: string,
): ProcessRegistry {
  const key = canonicalWorkspace(workspace)
  let registry = context.processes.get(key)
  if (!registry) {
    registry = new ProcessRegistry()
    context.processes.set(key, registry)
  }
  return registry
}

/** Computer use for a run, only when the person turned it on in Settings. */
export function computerSpec(config: SystemConfig): { computer: { driverPath?: string } | false } {
  // `false`, not absent: the Settings switch wins over an agent profile's options.
  if (!config.computerUse) return { computer: false }
  return { computer: config.computerDriverPath ? { driverPath: config.computerDriverPath } : {} }
}

/** Mount the browser Provider over the shared host and the model-visible tools. */
export async function mountBrowser(root: Context, host: PlaywrightBrowserHost | undefined): Promise<Array<{ dispose: () => Promise<void> }>> {
  if (!host) return []
  return [await root.plugin(browserPlaywright, { host }), await root.plugin(toolBrowser)]
}

export function adapterFromConfig(
  effective: EffectiveLlmConfig,
  apiKey: string,
): ReturnType<typeof openaiCompatAdapter> {
  const options: {
    apiKey: string
    baseUrl: string
    model: string
    protocol?: 'anthropic' | 'openai'
    apiKeyHeader?: 'x-api-key' | 'api-key'
    temperature?: number
    reasoningEffort?: 'low' | 'medium' | 'high'
    vision?: boolean
  } = {
    apiKey,
    baseUrl: effective.baseUrl,
    model: effective.model,
    vision: effective.vision,
  }
  if (effective.protocol) options.protocol = effective.protocol
  if (effective.apiKeyHeader) options.apiKeyHeader = effective.apiKeyHeader
  if (effective.temperature !== undefined) options.temperature = effective.temperature
  if (effective.reasoningEffort) options.reasoningEffort = effective.reasoningEffort
  return createLlmAdapter({ ...options, ...llmAuthOptions(effective) })
}

export function searchApiKey(effective: EffectiveLlmConfig, modelApiKey: string): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const host = new URL(effective.baseUrl).hostname.toLowerCase()
    if (host === 'deepseek.com' || host.endsWith('.deepseek.com')) return modelApiKey
  } catch {
    // A non-URL model route cannot provide a DeepSeek search credential.
  }
  return undefined
}

export function canonicalWorkspace(workspace: string): string {
  const resolved = resolve(workspace)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** A history cursor: a non-negative integer seq, or nothing when absent/invalid. */
export function optionalSeq(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** A requested page size, bounded so one request cannot ask for the whole log. */
export function optionalCount(value: string | null): number | undefined {
  const parsed = optionalSeq(value)
  if (parsed === undefined || parsed < 1) return undefined
  return Math.min(parsed, 500)
}

export function runKey(workspace: string, id: string): string {
  return `${canonicalWorkspace(workspace)}\0${id}`
}

export function isActive(
  active: Map<string, AbortController>,
  workspace: string,
  id: string,
): boolean {
  return active.has(runKey(workspace, id))
}

export function sessionFilePath(workspace: string, id: string): string {
  return sessionFile(workspace, id)
}

/**
 * What the model is told when the sandbox level changes.
 *
 * The permission guard enforces the level on every call, but nothing else puts
 * it in front of the model: without this notice the model keeps the level it
 * saw last, asks for escalations its level no longer needs, and reads a refusal
 * as a bug rather than as the policy.
 */
export function permissionNotice(permission: PermissionMode, workspace: string): string {
  switch (permission) {
    case 'read-only':
      return 'Session permission changed: read-only. Writing files, and any command that would write, is refused.'
    case 'workspace-write':
      return `Session permission changed: workspace-write. You can write inside ${workspace}; writes elsewhere and `
        + 'any command outside the sandbox need an explicit per-call escalation the user approves.'
    case 'bypass':
      return "Session permission changed: full access. Commands run outside the sandbox with your account's own permissions."
  }
}

/**
 * Append {@link permissionNotice} to the durable log when the model has not
 * been told the current level yet. A `system/message` is a surface event, so
 * the model sees it on every later request, while the client timeline keeps
 * it out of the human-facing history.
 *
 * Only for a Session with no running turn: during a turn the notice waits for
 * the next step boundary (see `@tnega/run-settings`), which carries it in the
 * same request it records.
 */
export async function appendPermissionNotice(workspace: string, id: string): Promise<void> {
  const file = sessionFilePath(workspace, id)
  const live = SessionLog.live(file)
  const log = live ?? new SessionLog(file)
  if (!live) await log.init()
  try {
    const level = pendingPermission(await log.read())
    if (!level) return
    await log.append('system/message', { content: permissionNotice(level, workspace), name: PERMISSION_NOTICE_NAME })
    await log.flush()
  } finally {
    if (!live) await log.close()
  }
}

type SessionEffort = 'default' | 'low' | 'medium' | 'high'
type Effort = NonNullable<EffectiveLlmConfig['reasoningEffort']>

function isEffort(value: string | undefined): value is Effort {
  return value === 'low' || value === 'medium' || value === 'high'
}

/**
 * The model route a Session runs with: its chosen model (or the default) and
 * its chosen effort, dropped when that model has no such effort.
 */
export function resolveSessionLlm(
  config: SystemConfig,
  model: string | undefined,
  effort: SessionEffort | undefined,
): { effective: EffectiveLlmConfig; apiKey: string | undefined } {
  const effective = effectiveLlmConfig(config, process.env, model)
  const capabilities = availableModels(config).find(option => option.id === effective.modelId)
    ?? modelCapabilities(effective.model, effective.protocol)
  const selected = effort === 'default' ? effective.reasoningEffort : effort ?? effective.reasoningEffort
  if (selected && capabilities.reasoningEfforts.includes(selected)) effective.reasoningEffort = selected
  else delete effective.reasoningEffort
  return { effective, apiKey: effectiveApiKey(config, process.env, effective.modelId) }
}

/**
 * The live model selection of one Session, for `@tnega/run-settings`: what the
 * next step should use, and an adapter for each route it names. Adapters are
 * kept per route and effort for the life of the runtime.
 */
export function sessionModelRoute(configFile: string | undefined, workspace: string, id: string): {
  selection: () => Promise<ModelSelection>
  adapterFor: (selection: ModelSelection) => Promise<LLMAdapter>
} {
  const adapters = new Map<string, LLMAdapter>()
  return {
    async selection() {
      const summary = await readSessionSummary(workspace, id)
      const { effective } = resolveSessionLlm(await readSystemConfig(configFile), summary.model, summary.reasoningEffort)
      return {
        route: effective.modelId,
        model: effective.model,
        ...(effective.reasoningEffort ? { reasoningEffort: effective.reasoningEffort } : {}),
      }
    },
    async adapterFor(selection) {
      const key = `${selection.route}\0${selection.reasoningEffort ?? ''}`
      const cached = adapters.get(key)
      if (cached) return cached
      const config = await readSystemConfig(configFile)
      const effective = effectiveLlmConfig(config, process.env, selection.route)
      if (isEffort(selection.reasoningEffort)) effective.reasoningEffort = selection.reasoningEffort
      else delete effective.reasoningEffort
      const apiKey = effectiveApiKey(config, process.env, effective.modelId)
      if (!apiKey) throw new Error(`API key is not configured for ${selection.route}`)
      const adapter = adapterFromConfig(effective, apiKey)
      adapters.set(key, adapter)
      return adapter
    },
  }
}

export function userMessage(prompt: string, attachments: readonly ModelAttachment[]): ModelMessage {
  return {
    role: 'user',
    content: prompt,
    ...(attachments.length ? { attachments: [...attachments] } : {}),
  }
}

/** Validated run attachments, or an error message for a malformed field. */
export function parseRunAttachments(value: unknown): ModelAttachment[] | string {
  if (value === undefined) return []
  if (!Array.isArray(value)) return 'attachments must be an array'
  if (value.length > MAX_RUN_ATTACHMENTS) return `at most ${MAX_RUN_ATTACHMENTS} attachments per message`
  const result: ModelAttachment[] = []
  for (const entry of value) {
    if (!isModelAttachment(entry)) return 'attachments must be base64 png, jpeg, webp or gif images'
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(entry.data)) return 'attachment data must be base64 without a data: prefix'
    result.push({
      type: 'image',
      mediaType: entry.mediaType,
      data: entry.data,
      ...(typeof entry.name === 'string' && entry.name ? { name: entry.name.slice(0, 200) } : {}),
    })
  }
  return result
}

export function compactionAdapter(effective: EffectiveLlmConfig, apiKey: string): ReturnType<typeof createLlmAdapter> {
  return createLlmAdapter({
    apiKey,
    baseUrl: effective.baseUrl,
    model: effective.model,
    ...(effective.protocol ? { protocol: effective.protocol } : {}),
    // A thinking model bills its reasoning against this cap, so the budget has
    // to cover the reasoning *plus* the summary it is the point of asking for.
    maxTokens: 8192,
    timeoutMs: 180_000,
    ...(effective.temperature !== undefined
      ? { temperature: effective.temperature }
      : {}),
    ...(effective.reasoningEffort ? { reasoningEffort: effective.reasoningEffort } : {}),
    ...llmAuthOptions(effective),
  })
}
