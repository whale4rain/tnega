import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_DEEPSEEK_MODEL, DEFAULT_OPENCODE_GO_BASE_URL } from '@tnega/llm'
import { resolveLlmEnv, type LlmEnvConfig } from './commands.js'

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
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'tnega', 'config.json')
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'tnega', 'config.json')
}

export async function readSystemConfig(file = systemConfigPath()): Promise<SystemConfig> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
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
  const model = envConfig.model ?? config.model ?? DEFAULT_DEEPSEEK_MODEL
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
