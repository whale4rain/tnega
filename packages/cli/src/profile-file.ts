import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Plugin } from '@tnega/core'
import type { AgentProfile } from './profile.js'
import { generalAgentProfile } from './profile.js'
import { parseYaml } from './yaml.js'

/** A serializable reference to a bundle: a built-in name, or an explicit bundler module. */
export type ProfileBundleRef =
  | { plugin?: undefined }
  | { plugin: Plugin }
  | { module: string }
  | { name: string }

export interface LoadableAgentProfile {
  name: string
  bundles: readonly ProfileBundleRef[]
  options?: Record<string, unknown>
}

export function profileDir(): string {
  if (process.platform === 'win32') {
    return join(homedir(), '.tnega', 'profiles')
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'tnega', 'profiles')
}

export function profileFile(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(profileDir(), `${normalized}.json`)
}

export function resolveProfileFile(nameOrFile: string): string {
  if (isAbsolute(nameOrFile)) return resolve(nameOrFile)
  const suffix = nameOrFile.endsWith('.json')
    || nameOrFile.endsWith('.yaml')
    || nameOrFile.endsWith('.yml')
  return suffix ? resolve(nameOrFile) : profileFile(nameOrFile)
}

function parseRecord(text: string, file: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (!trimmed) return {}
  const data = /^\s*\{/.test(trimmed)
    ? JSON.parse(trimmed) as unknown
    : parseYaml(trimmed)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`invalid profile file: ${file}`)
  }
  return data as Record<string, unknown>
}

function normalizeBundles(value: unknown, file: string): readonly ProfileBundleRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`profile bundles must be an array: ${file}`)
  const bundles: ProfileBundleRef[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry) bundles.push({ name: entry })
    else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      bundles.push({ plugin: entry as Plugin })
    } else {
      throw new Error(`invalid profile bundle entry in ${file}`)
    }
  }
  return bundles
}

export async function readAgentProfile(nameOrFile: string): Promise<AgentProfile> {
  const file = resolveProfileFile(nameOrFile)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && isAbsolute(file)) {
      throw new Error(`profile file not found: ${file}`, { cause: error })
    }
    throw error
  }
  const data = parseRecord(text, file)
  const name = typeof data.name === 'string' && data.name
    ? data.name
    : dirname(file).split(/[\\/]/).at(-1) ?? 'profile'
  const bundles = resolveBundles(normalizeBundles(data.bundles, file))
  const options = data.options && typeof data.options === 'object' && !Array.isArray(data.options)
    ? data.options
    : undefined
  return {
    name,
    bundles,
    ...(options ? { options: options as NonNullable<AgentProfile['options']> } : {}),
  }
}

function resolveBundles(refs: readonly ProfileBundleRef[]): readonly Plugin[] {
  const plugins: Plugin[] = []
  for (const ref of refs) {
    if ('plugin' in ref && ref.plugin) plugins.push(ref.plugin)
    else if ('name' in ref && ref.name === 'general') {
      // Built-in general bundle is empty; extending general is a no-op.
    } else if ('name' in ref && ref.name === 'default') {
      // 'default' maps to the shipped general profile.
    } else if ('name' in ref && ref.name) {
      throw new Error(`unknown built-in profile bundle: ${ref.name}`)
    } else if ('module' in ref && ref.module) {
      throw new Error(
        `external bundle module loading is disabled in this build: ${ref.module}`,
      )
    }
  }
  return plugins
}

export async function ensureProfileDir(): Promise<string> {
  const dir = profileDir()
  await mkdir(dir, { recursive: true })
  return dir
}

export { generalAgentProfile }
