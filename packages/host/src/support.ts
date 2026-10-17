import { browserPlaywright, type PlaywrightBrowserHost } from '@tnega/browser-playwright'
import { llmAuthOptions } from '@tnega/auth-chatgpt'
import type {  EffectiveLlmConfig  } from '@tnega/config'
import type {  Context, Plugin  } from '@tnega/core'
import { createLlmAdapter, openaiCompatAdapter } from '@tnega/llm'
import type {  HotPluginHost, PluginWorkshop  } from '@tnega/plugin-host'
import { isModelAttachment, type ModelAttachment, type ModelMessage } from '@tnega/session'
import { sessionFile } from '@tnega/session-store'
import { toolBrowser } from '@tnega/tool-browser'
import { ProcessRegistry } from '@tnega/tools'
import { resolve } from 'node:path'

export const MAX_RUN_ATTACHMENTS = 8
export const MAX_RUN_BODY_BYTES = 24 * 1024 * 1024

/** Host-level plugins the resident runtime mounts: the hot profile and the dev workshop. */
export function hostPlugins(context: { hotPlugins?: HotPluginHost; pluginWorkshop?: PluginWorkshop }): Plugin[] {
  return [
    ...(context.hotPlugins ? [context.hotPlugins.plugin] : []),
    ...(context.pluginWorkshop ? [context.pluginWorkshop.plugin] : []),
  ]
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

export function workspaceParam(url: URL): string | undefined {
  const value = url.searchParams.get('workspace')
  return value === null || !value.trim() ? undefined : value
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
