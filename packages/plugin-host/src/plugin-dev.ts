import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context, Plugin } from '@tnega/core'
import type { ToolsService } from '@tnega/tools'
import { createHotPluginHost, type HotPluginEvent, type HotPluginHost, type HotPluginStatus } from './plugin-hmr.js'
import { profileDir } from '@tnega/profile'

/**
 * Plugin dev mode: the agent writes plugins and patches them into itself.
 *
 * A workshop owns one directory of single-file plugins (`<name>.mjs`) and a
 * hot plugin host whose profile lists exactly those files. Its carrier plugin
 * mounts the current generation like any hot profile and adds the `plugin_*`
 * tools, so a plugin written in one step is live in the next step of the same
 * run. Off unless a host opts in (`tnega web --plugin-dev`).
 *
 * Guardrails: plugins run in the host process without the tool sandbox, so
 * `plugin_write` and `plugin_remove` always need approval outside bypass (see
 * `permissions.ts`); writes are confined to the workshop directory; a plugin
 * that fails to import or mount is rolled back on disk and in memory, so the
 * running generation is always one that loaded.
 */
export interface PluginWorkshop {
  readonly dir: string
  readonly host: HotPluginHost
  /** Mount into an agent runtime: the workshop's plugins plus the `plugin_*` tools. */
  readonly plugin: Plugin
  list(): Promise<readonly WorkshopPlugin[]>
  write(name: string, source: string): Promise<WorkshopResult>
  remove(name: string): Promise<WorkshopResult>
  close(): Promise<void>
}

export interface WorkshopPlugin {
  name: string
  file: string
  bytes: number
}

export interface WorkshopResult {
  ok: boolean
  generation: number
  error?: string
}

export interface PluginWorkshopOptions {
  /**
   * Also reload on hand edits in the directory. Off by default: the tools
   * already reload, and a second, watcher-driven remount right after a write
   * would briefly unregister the tools the agent is about to call.
   */
  watch?: boolean
  onEvent?: (event: HotPluginEvent) => void
}

export const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,39}$/
export const MAX_PLUGIN_BYTES = 64 * 1024
const PROFILE = 'profile.json'

/** `<config>/tnega/dev-plugins`, beside the profiles directory. */
export function defaultPluginDevDir(): string {
  return join(dirname(profileDir()), 'dev-plugins')
}

export async function createPluginWorkshop(
  dir = defaultPluginDevDir(),
  options: PluginWorkshopOptions = {},
): Promise<PluginWorkshop> {
  await mkdir(dir, { recursive: true })
  const profile = join(dir, PROFILE)
  await writeProfile(dir, await names(dir))
  const host = await createHotPluginHost(profile, {
    watch: options.watch ?? false,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  })
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task)
    queue = next.catch(() => undefined)
    return next
  }

  const fileOf = (name: string): string => {
    if (!PLUGIN_NAME.test(name)) {
      throw new TypeError('plugin name must be lowercase letters, digits and dashes, starting with a letter (max 40)')
    }
    return join(dir, `${name}.mjs`)
  }

  /** Apply a change, reload, and put the previous files back if the new generation fails. */
  const change = async (name: string, next: string | undefined): Promise<WorkshopResult> => {
    const file = fileOf(name)
    const previous = existsSync(file) ? await readFile(file, 'utf8') : undefined
    if (next === undefined) await rm(file, { force: true })
    else await writeFile(file, next)
    await writeProfile(dir, await names(dir))
    const status = await host.reload()
    if (!status.error) return { ok: true, generation: status.generation }
    if (previous === undefined) await rm(file, { force: true })
    else await writeFile(file, previous)
    await writeProfile(dir, await names(dir))
    const restored = await host.reload()
    return { ok: false, generation: restored.generation, error: status.error }
  }

  const list = async (): Promise<readonly WorkshopPlugin[]> => Promise.all((await names(dir)).map(async name => {
    const file = join(dir, `${name}.mjs`)
    return { name, file, bytes: Buffer.byteLength(await readFile(file, 'utf8')) }
  }))

  const workshop: PluginWorkshop = {
    dir,
    host,
    plugin: {
      name: 'tnega:plugin-workshop',
      async apply(ctx: Context) {
        await ctx.plugin(host.plugin)
        const tools = ctx.get('tools', false)
        if (tools) registerWorkshopTools(tools, workshop)
      },
    },
    list,
    write: (name, source) => serial(async () => {
      if (typeof source !== 'string' || !source.trim()) throw new TypeError('source is required')
      if (Buffer.byteLength(source) > MAX_PLUGIN_BYTES) throw new RangeError(`plugin source is over ${MAX_PLUGIN_BYTES} bytes`)
      return change(name, source)
    }),
    remove: name => serial(async () => {
      if (!existsSync(fileOf(name))) throw new Error(`no dev plugin named ${name}`)
      return change(name, undefined)
    }),
    close: () => host.close(),
  }
  return workshop
}

async function names(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
    .map(entry => entry.name.slice(0, -'.mjs'.length))
    .filter(name => PLUGIN_NAME.test(name))
    .sort()
}

async function writeProfile(dir: string, plugins: readonly string[]): Promise<void> {
  const profile = { name: 'plugin-dev', bundles: plugins.map(name => ({ module: `./${name}.mjs` })) }
  const text = `${JSON.stringify(profile, null, 2)}\n`
  const file = join(dir, PROFILE)
  if (existsSync(file) && await readFile(file, 'utf8') === text) return
  await writeFile(file, text)
}

const EXAMPLE = `export default function apply(ctx, config) {
  ctx.get('tools').register({
    schema: {
      name: 'word_count',
      description: 'Count the words in a text.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    execute: async input => ({ words: input.text.split(/\\s+/).filter(Boolean).length }),
  })
}`

function registerWorkshopTools(tools: ToolsService, workshop: PluginWorkshop): void {
  const toolNames = () => new Set(tools.list().map(tool => tool.schema.name))
  const report = async (result: WorkshopResult, before: ReadonlySet<string>) => {
    const after = toolNames()
    return {
      ...result,
      toolsAdded: [...after].filter(name => !before.has(name)).sort(),
      toolsRemoved: [...before].filter(name => !after.has(name)).sort(),
      plugins: (await workshop.list()).map(plugin => plugin.name),
      ...(result.ok ? {} : { note: 'The change was rolled back; the previous plugins are still running. Fix the error and write the plugin again.' }),
    }
  }

  tools.register({
    schema: {
      name: 'plugin_write',
      description: [
        'Plugin dev mode: create or replace a plugin and patch it into this agent right away.',
        'The source is one ES module (.mjs) whose default export is `apply(ctx, config)`; tools it registers are callable from your next step.',
        'Use only `ctx` (no imports of tnega packages): `ctx.get(\'tools\').register({schema, execute})` adds a tool, `ctx.on(event, fn)` listens, `ctx.effect(() => () => cleanup)` runs cleanup on unload.',
        'Everything a plugin registers is undone when it is replaced or removed. If it fails to import or mount, the change is rolled back and the error is returned.',
        'Plugins run inside the host process without the sandbox, so this needs approval.',
        `Example:\n${EXAMPLE}`,
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plugin name: lowercase letters, digits and dashes, e.g. "word-count".' },
          source: { type: 'string', description: 'The full module source.' },
        },
        required: ['name', 'source'],
        additionalProperties: false,
      },
    },
    async execute(input) {
      const { name, source } = input as { name: string; source: string }
      const before = toolNames()
      return report(await workshop.write(name, source), before)
    },
  })

  tools.register({
    schema: {
      name: 'plugin_remove',
      description: 'Plugin dev mode: unload a plugin written with plugin_write and delete its file. Its tools and listeners go away at once.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Plugin name.' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
    async execute(input) {
      const { name } = input as { name: string }
      const before = toolNames()
      return report(await workshop.remove(name), before)
    },
  })

  tools.register({
    schema: {
      name: 'plugin_list',
      description: 'Plugin dev mode: list the dev plugins, the loaded generation and the last load error.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    async execute() {
      const status: HotPluginStatus = workshop.host.status()
      return {
        dir: workshop.dir,
        generation: status.generation,
        ...(status.error ? { error: status.error } : {}),
        plugins: await workshop.list(),
      }
    },
  })

  tools.register({
    schema: {
      name: 'plugin_read',
      description: 'Plugin dev mode: read the source of a dev plugin, to change it with plugin_write.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Plugin name.' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
    async execute(input) {
      const { name } = input as { name: string }
      const plugin = (await workshop.list()).find(entry => entry.name === name)
      if (!plugin) throw new Error(`no dev plugin named ${name}`)
      return readFile(plugin.file, 'utf8')
    },
  })
}
