import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const outDir = fileURLToPath(new URL('../out/', import.meta.url))
await mkdir(outDir, { recursive: true })

const shared = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
  external: ['electron'],
}

await Promise.all([
  build({
    ...shared,
    entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('../out/main.js', import.meta.url)),
  }),
  build({
    ...shared,
    entryPoints: [fileURLToPath(new URL('../src/preload.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('../out/preload.js', import.meta.url)),
  }),
])
