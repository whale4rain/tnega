import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { registerHooks } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin } from '@tnega/core'
import type { AgentRuntimeOptions } from './commands.js'
import type { AgentProfile } from './profile.js'
import { bootAgentRuntime, generalAgentProfile } from './profile.js'
import { parseYaml } from './yaml.js'

/** A serializable reference to a bundle: a built-in name, or an explicit bundler module. */
export type ProfileBundleRef =
  | { plugin?: undefined }
  | { plugin: Plugin }
  | { module: string; export?: string; config?: unknown; disabled?: boolean }
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
    else if (isRecord(entry) && typeof entry.module === 'string' && entry.module.trim()) {
      if (entry.export !== undefined && (typeof entry.export !== 'string' || !entry.export)) {
        throw new Error(`invalid profile bundle export in ${file}`)
      }
      if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') {
        throw new Error(`invalid profile bundle disabled flag in ${file}`)
      }
      bundles.push({
        module: entry.module,
        ...(typeof entry.export === 'string' ? { export: entry.export } : {}),
        ...(entry.config !== undefined ? { config: entry.config } : {}),
        ...(typeof entry.disabled === 'boolean' ? { disabled: entry.disabled } : {}),
      })
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
  const bundles = await resolveBundles(normalizeBundles(data.bundles, file), file)
  const options = data.options && typeof data.options === 'object' && !Array.isArray(data.options)
    ? data.options
    : undefined
  return {
    name,
    bundles,
    ...(options ? { options: options as NonNullable<AgentProfile['options']> } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlugin(value: unknown): value is Plugin {
  return typeof value === 'function' || (isRecord(value) && typeof value.apply === 'function')
}

function resolveModule(specifier: string, file: string): string {
  if (specifier.startsWith('file:')) return specifier
  if (isAbsolute(specifier) || specifier.startsWith('.')) {
    return pathToFileURL(resolve(dirname(file), specifier)).href
  }
  // Node's parent argument to import.meta.resolve requires an experimental flag.
  // A synchronous hook supplies the profile parent while preserving ESM exports
  // conditions. Always remove it before importing or yielding to another task.
  const hook = registerHooks({
    resolve(request, context, nextResolve) {
      return nextResolve(request, request === specifier
        ? { ...context, parentURL: pathToFileURL(file).href }
        : context)
    },
  })
  try {
    return import.meta.resolve(specifier)
  } finally {
    hook.deregister()
  }
}

async function resolveBundles(refs: readonly ProfileBundleRef[], file: string): Promise<readonly Plugin[]> {
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
      if (ref.disabled) continue
      try {
        const specifier = resolveModule(ref.module, file)
        const namespace: unknown = await import(specifier)
        const plugin = isRecord(namespace)
          ? ref.export ? namespace[ref.export] : namespace.default ?? namespace
          : undefined
        if (!isPlugin(plugin)) throw new Error(`export ${ref.export ?? 'default/apply'} is not a plugin`)
        // A carrier Fiber owns the configured child plugin and all its effects.
        plugins.push({
          name: ref.module,
          async apply(ctx) {
            try {
              await ctx.plugin(plugin, ref.config)
            } catch (cause) {
              throw new Error(`failed to mount profile bundle ${ref.module} in ${file}`, { cause })
            }
          },
        })
      } catch (cause) {
        throw new Error(`failed to load profile bundle ${ref.module} in ${file}`, { cause })
      }
    }
  }
  return plugins
}

export async function ensureProfileDir(): Promise<string> {
  const dir = profileDir()
  await mkdir(dir, { recursive: true })
  return dir
}

export async function bootAgentRuntimeFromFile(
  base: Parameters<typeof bootAgentRuntime>[0],
  nameOrFile: string,
  overlay: Parameters<typeof bootAgentRuntime>[2] = {},
): Promise<AgentRuntimeOptions> {
  const profile = await readAgentProfile(nameOrFile)
  return bootAgentRuntime(base, profile, overlay)
}

export { generalAgentProfile }
