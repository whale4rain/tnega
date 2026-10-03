import { mkdtemp, mkdir, cp, rm, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { expect, test } from 'vitest'
import { Context } from '../../../packages/core/src/index.js'
import { desktopPtcAssets } from '../src/ptc-assets.js'
test('bundled desktop PTC executes from resources outside app.asar', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnega-desktop-ptc-'))
  const ctx = new Context()
  try {
    const runtimeRoot = join(directory, 'resources', 'tnega-runtime')
    await mkdir(join(runtimeRoot, 'dist'), { recursive: true })
    await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({ type: 'module' }))
    const worker = join(runtimeRoot, 'dist', 'ptc-worker.js')
    await build({
      entryPoints: [resolve('packages/ptc-runtime-quickjs/src/worker.mjs')],
      outfile: worker, bundle: true, platform: 'node', format: 'esm',
      banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
    })
    const piDirectory = await realpath(resolve('packages/ptc-runtime-quickjs/node_modules/@earendil-works/pi-codemode'))
    const piRequire = createRequire(join(piDirectory, 'package.json'))
    await cp(piRequire.resolve('quickjs-wasi/quickjs.wasm'), join(runtimeRoot, 'dist', 'quickjs.wasm'))
    const bundledProvider = join(directory, 'resources', 'app.asar', 'out', 'provider.mjs')
    await build({
      entryPoints: [resolve('packages/ptc-runtime-quickjs/src/index.ts')],
      outfile: bundledProvider, bundle: true, platform: 'node', format: 'esm',
      banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
    })
    const { QuickjsPtcRuntime } = await import(/* @vite-ignore */ pathToFileURL(bundledProvider).href)
    const runtime = new QuickjsPtcRuntime(ctx, desktopPtcAssets(runtimeRoot))
    const result = await runtime.execute({ code: 'text("packaged"); return 6 * 7;', tools: [] })
    expect(result).toMatchObject({ ok: true, value: 42, output: ['packaged'] })
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
