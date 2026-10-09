import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_MODEL, DEFAULT_OPENCODE_GO_BASE_URL, lookupModel, modelCapabilities, type LlmProtocol, type ReasoningEffort } from '@tnega/llm'
import type { ApprovalMode } from '@tnega/approval-review'
import { CHATGPT_CODEX_BASE_URL, CHATGPT_SIGNED_IN, isChatgptSignedIn } from './chatgpt-auth.js'

export interface ApprovalReviewerConfig {
  provider: 'conversation' | 'model' | 'jev' | 'openai'
  defaultMode?: ApprovalMode
  modelId?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  timeoutMs?: number
}

export function normalizeApprovalReviewer(value: unknown): ApprovalReviewerConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const provider: unknown = Reflect.get(value, 'provider')
  if (provider !== 'conversation' && provider !== 'model' && provider !== 'jev' && provider !== 'openai') return undefined
  const result: ApprovalReviewerConfig = { provider }
  const mode: unknown = Reflect.get(value, 'defaultMode')
  if (mode === 'manual' || mode === 'auto') result.defaultMode = mode
  for (const key of ['modelId', 'model', 'baseUrl', 'apiKey', 'apiKeyEnv'] as const) {
    const field: unknown = Reflect.get(value, key)
    if (typeof field === 'string') result[key] = field.trim()
  }
  const timeout: unknown = Reflect.get(value, 'timeoutMs')
  if (typeof timeout === 'number' && Number.isSafeInteger(timeout) && timeout >= 1_000 && timeout <= 120_000) result.timeoutMs = timeout
  return result
}

/**
 * What a model costs per million tokens, as the user entered it from the
 * provider's price list. Only used to estimate spend; nothing is billed here.
 */
export interface ModelPricing {
  input: number
  output: number
  /** Price of prompt tokens served from the provider's cache; defaults to `input`. */
  cachedInput?: number
  /** Display currency, e.g. `USD` or `CNY`; defaults to USD. */
  currency?: string
}

export function parseModelPricing(value: unknown): ModelPricing | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const price = (key: string): number | undefined => {
    const raw = record[key]
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined
  }
  const input = price('input')
  const output = price('output')
  if (input === undefined || output === undefined) return undefined
  const pricing: ModelPricing = { input, output }
  const cached = price('cachedInput')
  if (cached !== undefined) pricing.cachedInput = cached
  if (typeof record.currency === 'string' && /^[A-Za-z]{3}$/.test(record.currency.trim())) pricing.currency = record.currency.trim().toUpperCase()
  return pricing
}

export interface ConfiguredModel {
  /** Unique selector id. Defaults to the wire model id when model is omitted. */
  id: string
  model?: string
  name?: string
  baseUrl?: string
  protocol?: LlmProtocol
  apiKey?: string
  apiKeyEnv?: string
  apiKeyHeader?: 'x-api-key' | 'api-key'
  reasoningEfforts?: ReasoningEffort[]
  reasoningEffort?: ReasoningEffort
  contextWindow?: number
  /** Override the model-id heuristic for image input. */
  vision?: boolean
  pricing?: ModelPricing
  /** `chatgpt`: authenticate with the ChatGPT sign-in instead of an API key (see chatgpt-auth.ts). */
  auth?: 'chatgpt'
  source?: 'provider' | 'third-party'
}

/** The connection's origin, independent of its wire protocol or model name. */
export function modelSource(route: { source?: 'provider' | 'third-party'; auth?: 'chatgpt'; baseUrl?: string }): 'provider' | 'third-party' {
  if (route.source) return route.source
  if (route.auth === 'chatgpt') return 'provider'
  try {
    const host = new URL(route.baseUrl ?? '').hostname
    if (['api.openai.com', 'api.anthropic.com', 'api.deepseek.com', 'api.x.ai', 'generativelanguage.googleapis.com', 'api.mistral.ai', 'api.cohere.com'].includes(host)) return 'provider'
  } catch { /* A missing endpoint has no verified provider identity. */ }
  return 'third-party'
}

/** Resolve a registered connection, or the legacy default as one endpoint/key pair. */
export function modelConnection(config: SystemConfig, id: string, env: NodeJS.ProcessEnv = process.env): ConfiguredModel | undefined {
  const saved = config.models?.find(route => route.id === id)
  if (saved) {
    const effective = effectiveLlmConfig(config, env, id)
    const connection: ConfiguredModel = { ...saved, baseUrl: effective.baseUrl }
    const protocol = modelCapabilities(effective.model, effective.protocol).protocol
    connection.protocol = protocol
    if (effective.apiKeyHeader) connection.apiKeyHeader = effective.apiKeyHeader
    return connection
  }
  if (config.models?.length) return undefined
  const effective = effectiveLlmConfig(config, env)
  if (effective.modelId !== id) return undefined
  const route: ConfiguredModel = { id, model: effective.model, baseUrl: effective.baseUrl }
  if (effective.protocol) route.protocol = effective.protocol
  if (effective.apiKeyHeader) route.apiKeyHeader = effective.apiKeyHeader
  const key = effectiveApiKey(config, env, id)
  const variable = ['TNEGA_API_KEY', 'OPENCODE_GO_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'].find(name => key && env[name] === key)
  if (variable) route.apiKeyEnv = variable
  else if (key) route.apiKey = key
  return route
}

export interface LlmEnvConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface SystemConfig {
  projectMemory?: ProjectMemoryConfig
  codeMode?: boolean
  /** Shell for the `shell` tool (also when run as a background job): a name (`pwsh`, `bash`…) or a path; absent detects one. */
  shell?: string
  approvalReview?: ApprovalReviewerConfig
  apiKey?: string
  baseUrl?: string
  model?: string
  protocol?: 'anthropic' | 'openai'
  apiKeyHeader?: 'x-api-key' | 'api-key'
  temperature?: number
  reasoningEffort?: ReasoningEffort
  contextWindow?: number
  /** Override the image-input heuristic for the default route. */
  vision?: boolean
  models?: ConfiguredModel[]
  workspaces?: string[]
  /** Browser launched for the agent's `browser_*` tools outside the desktop app. */
  browser?: BrowserLaunchConfig
  network?: NetworkConfig
}

/** All Projects share daily limits. Reservations count uncached input, including failed calls. */
export interface ProjectMemoryConfig {
  enabled?: boolean
  coldModelId?: string
  maxCallsPerDay?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxTokensPerDay?: number
  minIntervalSeconds?: number
}

export const PROJECT_MEMORY_DEFAULTS = {
  enabled: true,
  coldModelId: '',
  maxCallsPerDay: 4,
  maxInputTokens: 16_384,
  maxOutputTokens: 512,
  maxTokensPerDay: 65_536,
  minIntervalSeconds: 300,
} satisfies Required<ProjectMemoryConfig>

export function normalizeProjectMemory(value: unknown): ProjectMemoryConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: ProjectMemoryConfig = {}
  const enabled: unknown = Reflect.get(value, 'enabled')
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') return undefined
    result.enabled = enabled
  }
  const route: unknown = Reflect.get(value, 'coldModelId')
  if (route !== undefined) {
    if (typeof route !== 'string') return undefined
    result.coldModelId = route.trim()
  }
  const bounds = { maxCallsPerDay: [0, 100], maxInputTokens: [1024, 131072], maxOutputTokens: [128, 4096], maxTokensPerDay: [0, 1_000_000], minIntervalSeconds: [0, 86400] } as const
  for (const key of Object.keys(bounds) as Array<keyof typeof bounds>) {
    const field: unknown = Reflect.get(value, key)
    if (field === undefined) continue
    const [min, max] = bounds[key]
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < min || field > max) return undefined
    result[key] = field
  }
  return result
}

/** How the HTTP tools reach the network (see `NetworkPolicy` in @tnega/execution). */
export interface NetworkConfig {
  /** Hosts trusted even when DNS answers with a private or reserved address; `*.domain` for subdomains. */
  allowedHosts?: string[]
  /** `http://host:port` proxy; absent uses HTTPS_PROXY / HTTP_PROXY / ALL_PROXY or the system proxy (desktop). */
  proxy?: string
}

export function parseNetworkConfig(value: unknown): NetworkConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const network: NetworkConfig = {}
  if (Array.isArray(record.allowedHosts)) {
    const hosts = record.allowedHosts
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim().toLowerCase())
      .filter(entry => /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(entry))
    if (hosts.length) network.allowedHosts = [...new Set(hosts)]
  }
  if (typeof record.proxy === 'string' && record.proxy.trim()) {
    try {
      const url = new URL(record.proxy.trim())
      if (url.protocol === 'http:' || url.protocol === 'https:') network.proxy = url.href.replace(/\/$/, '')
    } catch {
      // An unusable proxy is dropped rather than breaking every request.
    }
  }
  return network
}

export interface BrowserLaunchConfig {
  /** Chromium-based browser channel, e.g. `msedge`, `chrome`. */
  channel?: string
  executablePath?: string
  headless?: boolean
}

export interface EffectiveLlmConfig {
  apiKeySet: boolean
  modelId: string
  baseUrl: string
  model: string
  protocol?: 'anthropic' | 'openai'
  apiKeyHeader?: 'x-api-key' | 'api-key'
  temperature?: number
  reasoningEffort?: ReasoningEffort
  contextWindow?: number
  vision: boolean
  pricing?: ModelPricing
  /** Signs in with ChatGPT instead of an API key; see `llmAuthOptions`. */
  auth?: 'chatgpt'
}

export type SystemConfigPatch = Omit<SystemConfig, 'protocol' | 'reasoningEffort' | 'network'> & {
  protocol?: 'anthropic' | 'openai' | ''
  reasoningEffort?: ReasoningEffort | ''
  /** `undefined` written explicitly clears the network settings. */
  network?: NetworkConfig | undefined
}

export function systemConfigPath(): string {
  if (process.platform === 'win32') {
    return join(homedir(), '.tnega', 'config.json')
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'tnega', 'config.json')
}

function legacyWindowsConfigPath(): string | undefined {
  if (process.platform !== 'win32' || !process.env.APPDATA) return undefined
  const legacy = join(process.env.APPDATA, 'tnega', 'config.json')
  return legacy === systemConfigPath() ? undefined : legacy
}

/** The config file exists but is not valid JSON; writing over it would lose it. */
export class SystemConfigError extends Error {
  override name = 'SystemConfigError'
  constructor(readonly file: string, reason: string) {
    super(`${file} is not valid JSON (${reason}); fix or remove it before saving settings`)
  }
}

/** Why the config file cannot be read, or undefined when it is fine or absent. */
export async function systemConfigProblem(file = systemConfigPath()): Promise<string | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  try {
    JSON.parse(text)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export async function readSystemConfig(file = systemConfigPath()): Promise<SystemConfig> {
  const config = await readConfigFile(file)
  if (config !== undefined) return config
  const migrated = await migrateLegacyConfig(file)
  if (migrated !== undefined) return migrated
  return {}
}

async function readConfigFile(file: string): Promise<SystemConfig | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  return normalizeConfig(parsed)
}

async function migrateLegacyConfig(target: string): Promise<SystemConfig | undefined> {
  const legacy = legacyWindowsConfigPath()
  if (!legacy || target !== systemConfigPath()) return undefined
  const source = await readConfigFile(legacy)
  if (!source || Object.keys(source).length === 0) return undefined
  await writeSystemConfig(source, target)
  return source
}

export async function writeSystemConfig(
  config: SystemConfig,
  file = systemConfigPath(),
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export async function updateSystemConfig(
  patch: SystemConfigPatch,
  file = systemConfigPath(),
): Promise<SystemConfig> {
  // Reads fall back to defaults for a broken file; a write must not replace it.
  const problem = await systemConfigProblem(file)
  if (problem) throw new SystemConfigError(file, problem)
  const current = await readSystemConfig(file)
  const next: SystemConfig = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') {
      delete next[key as keyof SystemConfig]
    } else {
      (next as Record<string, unknown>)[key] = value
    }
  }
  await writeSystemConfig(next, file)
  return next
}

/** A chat model route as the Settings form sends it; an empty or missing key keeps the stored one. */
export interface ModelRouteInput {
  name?: string
  model: string
  protocol?: LlmProtocol | ''
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  contextWindow?: number
  vision?: boolean
  /** Prices per million tokens; `null` clears them. */
  pricing?: ModelPricing | null
  auth?: 'chatgpt'
  source?: 'provider' | 'third-party'
  /** Copy the saved connection without sending its key to the browser. */
  sourceRouteId?: string
}

export class ModelRouteError extends Error {
  override name = 'ModelRouteError'
}

const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/

export function parseModelRouteInput(value: unknown): ModelRouteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelRouteError('model route must be an object')
  const record = value as Record<string, unknown>
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (!model) throw new ModelRouteError('model is required')
  const input: ModelRouteInput = { model }
  for (const key of ['name', 'baseUrl', 'apiKey', 'apiKeyEnv', 'sourceRouteId'] as const) {
    if (record[key] === undefined) continue
    if (typeof record[key] !== 'string') throw new ModelRouteError(`${key} must be a string`)
    input[key] = record[key].trim()
  }
  if (record.auth !== undefined) {
    if (record.auth !== 'chatgpt') throw new ModelRouteError('auth must be chatgpt')
    input.auth = record.auth
  }
  if (record.source !== undefined) {
    if (record.source !== 'provider' && record.source !== 'third-party') throw new ModelRouteError('source must be provider or third-party')
    input.source = record.source
  }
  if (record.protocol !== undefined) {
    if (record.protocol !== 'openai' && record.protocol !== 'anthropic' && record.protocol !== '') throw new ModelRouteError('protocol must be openai, anthropic or empty')
    input.protocol = record.protocol
  }
  if (record.contextWindow !== undefined && record.contextWindow !== null) {
    if (!isContextWindow(record.contextWindow)) throw new ModelRouteError('contextWindow must be a positive whole number of tokens')
    input.contextWindow = record.contextWindow
  }
  if (record.vision !== undefined) {
    if (typeof record.vision !== 'boolean') throw new ModelRouteError('vision must be a boolean')
    input.vision = record.vision
  }
  if (record.pricing === null) input.pricing = null
  else if (record.pricing !== undefined) {
    const pricing = parseModelPricing(record.pricing)
    if (!pricing) throw new ModelRouteError('pricing needs non-negative input and output prices per million tokens')
    input.pricing = pricing
  }
  if (input.baseUrl) {
    try {
      const url = new URL(input.baseUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
    } catch {
      throw new ModelRouteError('baseUrl must be an http(s) URL')
    }
  }
  return input
}

/**
 * Add or replace one chat model route. Fields the form leaves out keep their
 * stored values, and a blank key keeps the saved credential.
 */
export async function upsertModelRoute(id: string, input: ModelRouteInput, file = systemConfigPath()): Promise<SystemConfig> {
  if (!ROUTE_ID.test(id)) throw new ModelRouteError('model route id may use letters, digits and . _ : / @ + -')
  const problem = await systemConfigProblem(file)
  if (problem) throw new SystemConfigError(file, problem)
  const current = await readSystemConfig(file)
  const routes = [...(current.models ?? [])]
  // The first registered route carries the single legacy route over, so adding
  // a second model never loses the one that was configured before.
  if (!routes.length && current.model && current.model !== id) {
    const legacy: ConfiguredModel = { id: current.model, model: current.model }
    if (current.baseUrl) legacy.baseUrl = current.baseUrl
    if (current.protocol) legacy.protocol = current.protocol
    if (current.apiKey) legacy.apiKey = current.apiKey
    if (current.apiKeyHeader) legacy.apiKeyHeader = current.apiKeyHeader
    if (current.contextWindow !== undefined) legacy.contextWindow = current.contextWindow
    if (current.vision !== undefined) legacy.vision = current.vision
    routes.push(legacy)
  }
  const index = routes.findIndex(route => route.id === id)
  const previous = index >= 0 ? routes[index]! : undefined
  const next: ConfiguredModel = { ...(previous ?? {}), id, model: input.model }
  if (input.sourceRouteId) {
    const source = modelConnection(current, input.sourceRouteId)
    if (!source) throw new ModelRouteError('source model route does not exist')
    if (input.baseUrl && input.baseUrl !== source.baseUrl && !input.apiKey) throw new ModelRouteError('a different endpoint needs its own API key')
    for (const key of ['baseUrl', 'protocol', 'apiKey', 'apiKeyEnv', 'apiKeyHeader', 'auth', 'source'] as const) delete next[key]
    if (source.baseUrl) next.baseUrl = source.baseUrl
    if (source.protocol) next.protocol = source.protocol
    if (source.apiKey) next.apiKey = source.apiKey
    if (source.apiKeyEnv) next.apiKeyEnv = source.apiKeyEnv
    if (source.apiKeyHeader) next.apiKeyHeader = source.apiKeyHeader
    if (source.auth) next.auth = source.auth
    next.source = modelSource(source)
    if (input.apiKey) { delete next.apiKeyEnv; delete next.auth }
    if (input.apiKeyEnv && input.apiKeyEnv !== source.apiKeyEnv) { delete next.apiKey; delete next.auth }
  }
  for (const key of ['name', 'baseUrl', 'apiKeyEnv'] as const) {
    if (input[key] === undefined) continue
    if (input[key]) next[key] = input[key]
    else delete next[key]
  }
  if (input.apiKey) next.apiKey = input.apiKey
  if (input.protocol !== undefined) {
    if (input.protocol) next.protocol = input.protocol
    else delete next.protocol
  }
  if (input.contextWindow !== undefined) next.contextWindow = input.contextWindow
  if (input.vision !== undefined) next.vision = input.vision
  if (input.pricing === null) delete next.pricing
  else if (input.pricing) next.pricing = input.pricing
  if (input.auth) next.auth = input.auth
  if (input.source) next.source = input.source
  if (index >= 0) routes[index] = next
  else routes.push(next)
  const config: SystemConfig = { ...current, models: routes }
  await writeSystemConfig(config, file)
  return config
}

/** Remove a chat model route; the default falls back to the next route when it was this one. */
export async function removeModelRoute(id: string, file = systemConfigPath()): Promise<SystemConfig> {
  const problem = await systemConfigProblem(file)
  if (problem) throw new SystemConfigError(file, problem)
  const current = await readSystemConfig(file)
  if (!current.models?.some(route => route.id === id)) throw new ModelRouteError(`no model route ${id}`)
  const config: SystemConfig = { ...current, models: current.models.filter(route => route.id !== id) }
  if (!config.models?.length) delete config.models
  if (config.model === id) delete config.model
  if (config.approvalReview?.modelId === id) config.approvalReview = { ...config.approvalReview, modelId: '' }
  if (config.projectMemory?.coldModelId === id) config.projectMemory = { ...config.projectMemory, coldModelId: '' }
  await writeSystemConfig(config, file)
  return config
}

export function effectiveLlmConfig(
  config: SystemConfig,
  env: NodeJS.ProcessEnv = process.env,
  selectedModel?: string,
): EffectiveLlmConfig {
  const envConfig = resolveLlmEnv(env)
  const modelId = selectedModel ?? envConfig.model ?? config.model ?? config.models?.[0]?.id ?? DEFAULT_MODEL
  const profile = config.models?.find(entry => entry.id === modelId)
  const apiKey = effectiveApiKey(config, env, modelId)
  const baseUrl = profile?.baseUrl ?? (profile?.auth === 'chatgpt' ? CHATGPT_CODEX_BASE_URL : undefined)
    ?? envConfig.baseUrl ?? config.baseUrl ?? DEFAULT_OPENCODE_GO_BASE_URL
  const model = profile?.model ?? modelId
  const result: EffectiveLlmConfig = {
    apiKeySet: Boolean(apiKey),
    baseUrl,
    model,
    modelId,
    vision: false,
  }
  const protocol = profile?.protocol ?? (profile ? undefined : config.protocol)
  if (protocol) result.protocol = protocol
  const apiKeyHeader = profile?.apiKeyHeader ?? config.apiKeyHeader
  if (apiKeyHeader) result.apiKeyHeader = apiKeyHeader
  if (profile?.pricing) result.pricing = profile.pricing
  if (profile?.auth) result.auth = profile.auth
  if (config.temperature !== undefined) result.temperature = config.temperature
  const contextWindow = profile?.contextWindow ?? config.contextWindow ?? lookupModel(model)?.contextWindow
  if (contextWindow !== undefined) result.contextWindow = contextWindow
  const capabilities = modelCapabilities(model, protocol, profile ? profile.reasoningEfforts ?? [] : undefined, profile ? profile.vision : config.vision)
  result.vision = capabilities.vision
  const supported = capabilities.reasoningEfforts
  const defaultEffort = profile?.reasoningEffort ?? config.reasoningEffort
  if (defaultEffort && supported.includes(defaultEffort)) result.reasoningEffort = defaultEffort
  return result
}

export function availableModels(config: SystemConfig, env: NodeJS.ProcessEnv = process.env): Array<{
  id: string
  name: string
  protocol: LlmProtocol
  reasoningEfforts: readonly ReasoningEffort[]
  vision: boolean
  apiKeySet: boolean
  contextWindow?: number
  source: 'provider' | 'third-party'
}> {
  const effective = effectiveLlmConfig(config, env)
  const ids = [...new Set([effective.modelId, ...(config.models?.map(entry => entry.id) ?? [])])]
  return ids.map(id => {
    const profile = config.models?.find(entry => entry.id === id)
    const route = effectiveLlmConfig(config, env, id)
    return {
      id,
      name: profile?.name ?? id,
      source: modelSource({ ...profile, baseUrl: route.baseUrl }),
      ...modelCapabilities(route.model, route.protocol, profile ? profile.reasoningEfforts ?? [] : undefined, profile ? profile.vision : config.vision),
      apiKeySet: route.apiKeySet,
      ...(route.contextWindow !== undefined ? { contextWindow: route.contextWindow } : {}),
    }
  })
}

export function toLlmEnvConfig(config: SystemConfig): LlmEnvConfig {
  const result: LlmEnvConfig = {}
  if (config.apiKey) result.apiKey = config.apiKey
  if (config.baseUrl) result.baseUrl = config.baseUrl
  if (config.model) result.model = config.model
  return result
}

export function effectiveApiKey(
  config: SystemConfig,
  env: NodeJS.ProcessEnv = process.env,
  selectedModel?: string,
): string | undefined {
  const profile = config.models?.find(entry => entry.id === selectedModel)
  if (profile?.auth === 'chatgpt') return isChatgptSignedIn() ? CHATGPT_SIGNED_IN : undefined
  if (profile?.apiKeyEnv) return env[profile.apiKeyEnv] || profile.apiKey
  if (profile?.apiKey) return profile.apiKey
  if (env.TNEGA_API_KEY) return env.TNEGA_API_KEY
  if (config.protocol && config.apiKey) return config.apiKey
  return resolveLlmEnv(env).apiKey ?? config.apiKey
}

export function resolveLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  const config: LlmEnvConfig = {}
  const apiKey = env.TNEGA_API_KEY
    || env.OPENCODE_GO_API_KEY
    || env.OPENAI_API_KEY
    || env.DEEPSEEK_API_KEY
  if (apiKey) config.apiKey = apiKey
  if (env.OPENCODE_GO_BASE_URL) config.baseUrl = env.OPENCODE_GO_BASE_URL
  if (env.OPENCODE_GO_MODEL) config.model = env.OPENCODE_GO_MODEL
  return config
}

function normalizeConfig(value: unknown): SystemConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const config: SystemConfig = {}
  if (typeof record.codeMode === 'boolean') config.codeMode = record.codeMode
  const memory = normalizeProjectMemory(record.projectMemory)
  if (memory) config.projectMemory = memory
  else if (record.projectMemory !== undefined) config.projectMemory = { enabled: false }
  if (typeof record.shell === 'string' && record.shell.trim()) config.shell = record.shell.trim()
  const review = normalizeApprovalReviewer(record.approvalReview)
  if (review) config.approvalReview = review
  if (typeof record.apiKey === 'string' && record.apiKey) config.apiKey = record.apiKey
  if (typeof record.baseUrl === 'string' && record.baseUrl) config.baseUrl = record.baseUrl
  if (typeof record.model === 'string' && record.model) config.model = record.model
  if (record.protocol === 'anthropic' || record.protocol === 'openai') {
    config.protocol = record.protocol
  }
  if (record.apiKeyHeader === 'x-api-key' || record.apiKeyHeader === 'api-key') {
    config.apiKeyHeader = record.apiKeyHeader
  }
  if (typeof record.temperature === 'number' && Number.isFinite(record.temperature)) {
    config.temperature = record.temperature
  }
  if (isContextWindow(record.contextWindow)) config.contextWindow = record.contextWindow
  if (typeof record.vision === 'boolean') config.vision = record.vision
  if (record.reasoningEffort === 'low' || record.reasoningEffort === 'medium' || record.reasoningEffort === 'high') {
    config.reasoningEffort = record.reasoningEffort
  }
  if (Array.isArray(record.models)) {
    const seen = new Set<string>()
    config.models = record.models.flatMap(entry => {
      const id = stringField(entry, 'id')?.trim()
      if (!id || seen.has(id)) return []
      seen.add(id)
      const model: ConfiguredModel = { id }
      for (const field of ['model', 'name', 'baseUrl', 'apiKey', 'apiKeyEnv'] as const) {
        const value = stringField(entry, field)?.trim()
        if (value) model[field] = value
      }
      const protocol = stringField(entry, 'protocol')
      if (protocol === 'openai' || protocol === 'anthropic') model.protocol = protocol
      const header = stringField(entry, 'apiKeyHeader')
      if (header === 'x-api-key' || header === 'api-key') model.apiKeyHeader = header
      const effort = stringField(entry, 'reasoningEffort')
      if (effort === 'low' || effort === 'medium' || effort === 'high') model.reasoningEffort = effort
      const contextWindow = fieldOf(entry, 'contextWindow')
      if (isContextWindow(contextWindow)) model.contextWindow = contextWindow
      const vision = fieldOf(entry, 'vision')
      if (typeof vision === 'boolean') model.vision = vision
      const pricing = parseModelPricing(fieldOf(entry, 'pricing'))
      if (pricing) model.pricing = pricing
      if (fieldOf(entry, 'auth') === 'chatgpt') model.auth = 'chatgpt'
      const source = fieldOf(entry, 'source')
      if (source === 'provider' || source === 'third-party') model.source = source
      const efforts = fieldOf(entry, 'reasoningEfforts')
      if (Array.isArray(efforts)) {
        model.reasoningEfforts = [...new Set(efforts.filter(isReasoningEffort))]
      }
      return [model]
    })
  }
  const browser = fieldOf(record, 'browser')
  if (browser && typeof browser === 'object' && !Array.isArray(browser)) {
    const launch: BrowserLaunchConfig = {}
    const channel = stringField(browser, 'channel')?.trim()
    if (channel) launch.channel = channel
    const executablePath = stringField(browser, 'executablePath')?.trim()
    if (executablePath) launch.executablePath = executablePath
    const headless = fieldOf(browser, 'headless')
    if (typeof headless === 'boolean') launch.headless = headless
    config.browser = launch
  }
  const network = parseNetworkConfig(fieldOf(record, 'network'))
  if (network && (network.allowedHosts || network.proxy)) config.network = network
  if (Array.isArray(record.workspaces)) {
    config.workspaces = record.workspaces
      .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry))
  }
  return config
}

function isContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function fieldOf(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Reflect.get(value, key) : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  const field = fieldOf(value, key)
  return typeof field === 'string' ? field : undefined
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high'
}
