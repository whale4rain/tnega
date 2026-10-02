import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { Context, Fiber, Plugin } from '@tnega/core'
import { loadAgentProfile, profileDir } from './profile-file.js'

/** What a hot plugin host reports after each load attempt. */
export type HotPluginEvent =
  | { type: 'loaded'; generation: number; plugins: number; files: readonly string[] }
  | { type: 'error'; generation: number; error: unknown }

export interface HotPluginStatus {
  file: string
  /** Increases on every successful load; 0 means nothing has loaded yet. */
  generation: number
  plugins: number
  error?: string
  loadedAt?: number
}

export interface HotPluginHostOptions {
  /** Debounce for bursts of file events (editors write in several steps). Defaults to 120ms. */
  debounceMs?: number
  /** Turn the file watcher off; `reload()` still works. */
  watch?: boolean
  onEvent?: (event: HotPluginEvent) => void
}

/**
 * Profile plugins that reload while the host keeps running.
 *
 * Mount `host.plugin` into any runtime: it mounts the profile's current plugins
 * as child Fibers and, whenever the profile file or a local plugin module
 * changes, disposes them and mounts the new generation in place. A failed load
 * keeps the previous generation running.
 */
export interface HotPluginHost {
  readonly file: string
  readonly plugin: Plugin
  status(): HotPluginStatus
  reload(): Promise<HotPluginStatus>
  close(): Promise<void>
}

const PROFILE_NAMES = ['default.yaml', 'default.yml', 'default.json']

/** The profile the web host loads when none is configured: `<profileDir>/default.{yaml,yml,json}`. */
export function defaultHotProfile(): string {
  const dir = profileDir()
  return PROFILE_NAMES.map(name => join(dir, name)).find(existsSync) ?? join(dir, PROFILE_NAMES[0]!)
}

export async function createHotPluginHost(
  profile: string,
  options: HotPluginHostOptions = {},
): Promise<HotPluginHost> {
  const file = resolve(profile)
  const debounceMs = options.debounceMs ?? 120
  let generation = 0
  let current: readonly Plugin[] = []
  let status: HotPluginStatus = { file, generation: 0, plugins: 0 }
  let watched = new Set<string>()
  let moduleDirs: readonly string[] = []
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let queue: Promise<unknown> = Promise.resolve()
  const mounts = new Set<(plugins: readonly Plugin[]) => Promise<void>>()

  const load = async (): Promise<HotPluginStatus> => {
    const attempt = generation + 1
    let loaded: Awaited<ReturnType<typeof loadAgentProfile>> | undefined
    try {
      loaded = existsSync(file) ? await loadAgentProfile(file, { version: attempt }) : undefined
    } catch (error) {
      status = { ...status, error: errorText(error) }
      options.onEvent?.({ type: 'error', generation: attempt, error })
      return status
    }
    generation = attempt
    current = loaded?.profile.bundles ?? []
    moduleDirs = (loaded?.localModules ?? []).map(entry => dirname(resolve(entry)))
    await updateWatch()
    const failures: unknown[] = []
    for (const remount of mounts) await remount(current).catch((error: unknown) => { failures.push(error) })
    status = {
      file, generation, plugins: current.length, loadedAt: Date.now(),
      ...(failures.length ? { error: errorText(failures[0]) } : {}),
    }
    if (failures.length) options.onEvent?.({ type: 'error', generation, error: failures[0] })
    else options.onEvent?.({ type: 'loaded', generation, plugins: current.length, files: [file, ...moduleDirs] })
    return status
  }

  /** Loads run one at a time, in request order. */
  const reload = (): Promise<HotPluginStatus> => {
    const next = queue.then(() => closed ? status : load())
    queue = next.catch(() => undefined)
    return next
  }

  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void reload() }, debounceMs)
  }

  const relevant = (path: string): boolean => resolve(path) === file
    || moduleDirs.some(dir => isInside(resolve(path), dir))

  /**
   * Watch the profile's directory, so creating or replacing the file counts, and
   * each local module's directory, so edits to the files a module imports count.
   */
  const updateWatch = async (): Promise<void> => {
    if (options.watch === false || closed) return
    const next = new Set([dirname(file), ...moduleDirs])
    if (watcher && sameSet(next, watched)) return
    const previous = watcher
    watched = next
    watcher = watch([...next], {
      ignoreInitial: true,
      ignored: (path: string) => /[\\/](node_modules|\.git)([\\/]|$)/.test(path),
    })
    watcher.on('all', (_event, path) => { if (relevant(path)) schedule() })
    const ready = new Promise<void>(resolveReady => watcher?.once('ready', () => resolveReady()))
    await previous?.close()
    await ready
  }

  const plugin: Plugin = {
    name: 'tnega:hot-plugins',
    async apply(ctx: Context) {
      let fibers: Fiber[] = []
      let mounted: readonly Plugin[] = []
      const unmount = async () => {
        const previous = fibers
        fibers = []
        for (const fiber of previous.reverse()) await fiber.dispose()
      }
      const mountAll = async (plugins: readonly Plugin[]) => {
        for (const child of plugins) fibers.push(await ctx.plugin(child))
        mounted = plugins
      }
      const remount = async (plugins: readonly Plugin[]) => {
        const previous = mounted
        await unmount()
        try {
          await mountAll(plugins)
        } catch (error) {
          // Roll back to the generation that was running.
          await unmount()
          await mountAll(previous).catch(() => unmount())
          throw error
        }
      }
      await mountAll(current)
      mounts.add(remount)
      ctx.effect(() => () => { mounts.delete(remount) })
    },
  }

  if (options.watch !== false) await mkdir(dirname(file), { recursive: true })
  await reload()

  return {
    file,
    plugin,
    status: () => status,
    reload,
    close: async () => {
      closed = true
      if (timer) clearTimeout(timer)
      mounts.clear()
      await watcher?.close()
    },
  }
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every(entry => b.has(entry))
}

function errorText(error: unknown): string {
  const parts: string[] = []
  let cursor: unknown = error
  while (cursor instanceof Error && parts.length < 4) {
    parts.push(cursor.message)
    cursor = cursor.cause
  }
  return parts.join(': ') || String(error)
}
