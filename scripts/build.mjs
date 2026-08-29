/* global URL */

import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })
await mkdir(new URL('../dist/', import.meta.url), { recursive: true })

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
}

await build({
  ...common,
  entryPoints: ['packages/cli/src/bin.ts'],
  outfile: 'dist/bin.js',
})
chmodSync(new URL('../dist/bin.js', import.meta.url), 0o755)

await build({
  ...common,
  entryPoints: ['packages/cli/src/index.ts'],
  outfile: 'dist/index.js',
})

const webCwd = fileURLToPath(new URL('../apps/web/', import.meta.url))
const viteBin = fileURLToPath(
  new URL('../apps/web/node_modules/vite/bin/vite.js', import.meta.url),
)
const webBuild = spawnSync(
  process.execPath,
  [viteBin, 'build', '--outDir', '../../dist/web', '--emptyOutDir'],
  { cwd: webCwd, stdio: 'inherit' },
)
if (webBuild.status !== 0) {
  throw new Error(
    `vite build failed with status ${webBuild.status ?? 'unknown'}`,
  )
}
