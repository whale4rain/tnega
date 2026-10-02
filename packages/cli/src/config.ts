import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_MODEL, DEFAULT_OPENCODE_GO_BASE_URL, lookupModel, modelCapabilities, type LlmProtocol, type ReasoningEffort } from '@tnega/llm'
import type { ApprovalMode } from '@tnega/approval-review'

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
}

export interface LlmEnvConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface SystemConfig {
  codeMode?: boolean
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
}

export type SystemConfigPatch = Omit<SystemConfig, 'protocol' | 'reasoningEffort'> & {
  protocol?: 'anthropic' | 'openai' | ''
  reasoningEffort?: ReasoningEffort | ''
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

export function effectiveLlmConfig(
  config: SystemConfig,
  env: NodeJS.ProcessEnv = process.env,
  selectedModel?: string,
): EffectiveLlmConfig {
  const envConfig = resolveLlmEnv(env)
  const modelId = selectedModel ?? envConfig.model ?? config.model ?? config.models?.[0]?.id ?? DEFAULT_MODEL
  const profile = config.models?.find(entry => entry.id === modelId)
  const apiKey = effectiveApiKey(config, env, modelId)
  const baseUrl = profile?.baseUrl ?? envConfig.baseUrl ?? config.baseUrl ?? DEFAULT_OPENCODE_GO_BASE_URL
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
}> {
  const effective = effectiveLlmConfig(config, env)
  const ids = [...new Set([effective.modelId, ...(config.models?.map(entry => entry.id) ?? [])])]
  return ids.map(id => {
    const profile = config.models?.find(entry => entry.id === id)
    const route = effectiveLlmConfig(config, env, id)
    return {
      id,
      name: profile?.name ?? id,
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
