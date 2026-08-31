import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_MODEL, DEFAULT_OPENCODE_GO_BASE_URL } from '@tnega/llm'

export interface LlmEnvConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface SystemConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  temperature?: number
  workspaces?: string[]
}

export interface EffectiveLlmConfig {
  apiKeySet: boolean
  baseUrl: string
  model: string
  temperature?: number
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
  patch: SystemConfig,
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
): EffectiveLlmConfig {
  const envConfig = resolveLlmEnv(env)
  const apiKey = envConfig.apiKey ?? config.apiKey
  const baseUrl = envConfig.baseUrl ?? config.baseUrl ?? DEFAULT_OPENCODE_GO_BASE_URL
  const model = envConfig.model ?? config.model ?? DEFAULT_MODEL
  const result: EffectiveLlmConfig = {
    apiKeySet: Boolean(apiKey),
    baseUrl,
    model,
  }
  if (config.temperature !== undefined) result.temperature = config.temperature
  return result
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
): string | undefined {
  return resolveLlmEnv(env).apiKey ?? config.apiKey
}

export function resolveLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  const config: LlmEnvConfig = {}
  const apiKey = env.OPENCODE_GO_API_KEY || env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY
  if (apiKey) config.apiKey = apiKey
  if (env.OPENCODE_GO_BASE_URL) config.baseUrl = env.OPENCODE_GO_BASE_URL
  if (env.OPENCODE_GO_MODEL) config.model = env.OPENCODE_GO_MODEL
  return config
}

function normalizeConfig(value: unknown): SystemConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const config: SystemConfig = {}
  if (typeof record.apiKey === 'string' && record.apiKey) config.apiKey = record.apiKey
  if (typeof record.baseUrl === 'string' && record.baseUrl) config.baseUrl = record.baseUrl
  if (typeof record.model === 'string' && record.model) config.model = record.model
  if (typeof record.temperature === 'number' && Number.isFinite(record.temperature)) {
    config.temperature = record.temperature
  }
  if (Array.isArray(record.workspaces)) {
    config.workspaces = record.workspaces
      .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry))
  }
  return config
}
