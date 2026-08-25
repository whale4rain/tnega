/* global URL */

import { chmodSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
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
