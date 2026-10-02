import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@tnega/core'
import { afterEach, describe, expect, it } from 'vitest'

import { createHotPluginHost, type HotPluginEvent, type HotPluginHost } from '../src/plugin-hmr.js'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const dirs: string[] = []
const hosts: HotPluginHost[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-plugin-hmr-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A plugin that answers `hmr/probe` with a word read from an imported local file. */
async function writePlugin(dir: string, word: string): Promise<void> {
  await mkdir(join(dir, 'plugins'), { recursive: true })
  await writeFile(join(dir, 'plugins', 'word.mjs'), `export const word = ${JSON.stringify(word)}\n`)
  await writeFile(join(dir, 'plugins', 'probe.mjs'), `
    import { word } from './word.mjs'
    export default function apply(ctx, config) {
      ctx.on('hmr/probe', out => { out.push(config.prefix + word) })
      ctx.effect(() => () => { globalThis.__tnegaHmrDisposed = (globalThis.__tnegaHmrDisposed ?? 0) + 1 })
    }
  `)
}

function probe(ctx: Context): string[] {
  const out: string[] = []
  ctx.emit('hmr/probe', out)
  return out
}

function waitFor(events: HotPluginEvent[], predicate: (event: HotPluginEvent) => boolean): Promise<HotPluginEvent> {
  return new Promise((resolveWait, rejectWait) => {
    const started = Date.now()
    const tick = () => {
      const hit = events.find(predicate)
      if (hit) return resolveWait(hit)
      if (Date.now() - started > 8000) return rejectWait(new Error('timed out waiting for a hot reload'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

describe('hot plugin host', () => {
  it('remounts mounted plugins in place when the profile changes', async () => {
    const dir = await tempDir()
    await writePlugin(dir, 'one')
    const file = join(dir, 'default.yaml')
    await writeFile(file, 'bundles:\n  - module: ./plugins/probe.mjs\n    config:\n      prefix: "v:"\n')
    const events: HotPluginEvent[] = []
    const host = await createHotPluginHost(file, { debounceMs: 20, onEvent: event => events.push(event) })
    hosts.push(host)
    const root = new Context()
    const fiber = await root.plugin(host.plugin)
    expect(probe(root)).toEqual(['v:one'])

    await writeFile(file, 'bundles:\n  - module: ./plugins/probe.mjs\n    config:\n      prefix: "v2:"\n')
    await waitFor(events, event => event.type === 'loaded' && event.generation === 2)
    expect(probe(root)).toEqual(['v2:one'])
    expect(Reflect.get(globalThis, '__tnegaHmrDisposed')).toBeGreaterThanOrEqual(1)

    await fiber.dispose()
    expect(probe(root)).toEqual([])
  })

  // Vitest loads modules through its own runner, which skips Node's module hooks,
  // so the import-graph reload runs in a plain Node child process.
  it('reloads the local files a plugin imports under plain Node', async () => {
    const dir = await tempDir()
    await writePlugin(dir, 'one')
    const file = join(dir, 'default.yaml')
    await writeFile(file, 'bundles:\n  - module: ./plugins/probe.mjs\n    config:\n      prefix: ""\n')
    const script = join(repoRoot, 'packages', 'cli', 'test', 'fixtures', 'hmr-child.ts')
    const { stdout } = await execFileAsync(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--experimental-transform-types',
      '--experimental-loader', './scripts/ts-import-loader.mjs', script, file, join(dir, 'plugins', 'word.mjs'),
    ], { cwd: repoRoot, timeout: 30_000 })
    expect(stdout.trim().split('\n').at(-1)?.trim()).toBe('one -> two')
  }, 40_000)

  it('keeps the running generation when a reload fails', async () => {
    const dir = await tempDir()
    await writePlugin(dir, 'stable')
    const file = join(dir, 'default.json')
    await writeFile(file, JSON.stringify({ bundles: [{ module: './plugins/probe.mjs', config: { prefix: '' } }] }))
    const host = await createHotPluginHost(file, { watch: false })
    hosts.push(host)
    const root = new Context()
    await root.plugin(host.plugin)

    await writeFile(join(dir, 'plugins', 'probe.mjs'), 'export default function (ctx {')
    const status = await host.reload()
    expect(status.generation).toBe(1)
    expect(status.error).toMatch(/probe\.mjs/)
    expect(probe(root)).toEqual(['stable'])
  })

  it('starts empty and picks the profile up once it is created', async () => {
    const dir = await tempDir()
    await writePlugin(dir, 'late')
    const file = join(dir, 'default.yaml')
    const events: HotPluginEvent[] = []
    const host = await createHotPluginHost(file, { debounceMs: 20, onEvent: event => events.push(event) })
    hosts.push(host)
    const root = new Context()
    await root.plugin(host.plugin)
    expect(host.status().plugins).toBe(0)

    await writeFile(file, 'bundles:\n  - module: ./plugins/probe.mjs\n    config:\n      prefix: ""\n')
    await waitFor(events, event => event.type === 'loaded' && event.plugins === 1)
    expect(probe(root)).toEqual(['late'])
  })
})

describe('web server plugin profile', () => {
  it('reports and reloads the hot plugin profile', async () => {
    const { startWebServer } = await import('../src/server.js')
    const dir = await tempDir()
    await writePlugin(dir, 'served')
    const file = join(dir, 'default.yaml')
    await writeFile(file, 'bundles:\n  - module: ./plugins/probe.mjs\n')
    const server = await startWebServer({ port: 0, browser: false, profile: file, configFile: join(dir, 'config.json') })
    try {
      const headers = { 'x-tnega-client': '1', 'content-type': 'application/json' }
      const status = await (await fetch(`${server.url}/api/plugins`, { headers })).json() as Record<string, unknown>
      expect(status).toMatchObject({ enabled: true, generation: 1, plugins: 1 })
      const reloaded = await (await fetch(`${server.url}/api/plugins/reload`, { method: 'POST', headers })).json() as Record<string, unknown>
      expect(reloaded).toMatchObject({ enabled: true, generation: 2, plugins: 1 })
    } finally {
      await server.close()
    }
  })
})
