import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const outDir = fileURLToPath(new URL('../out/', import.meta.url))
await mkdir(outDir, { recursive: true })

const shared = {
  bundle: true,
  loader: { '.md': 'text' },
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
  // playwright-core loads its own files at runtime, and electron-updater reads
  // app-update.yml beside the app, so both ship as dependencies.
  external: ['electron', 'playwright-core', 'electron-updater', '@lydell/node-pty', 'koffi'],
}

await Promise.all([
  build({
    ...shared,
    entryPoints: [fileURLToPath(new URL('../../../packages/sandbox/sandbox-windows-acl/src/runner.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('../out/sandbox-windows-acl-runner.js', import.meta.url)),
  }),
  build({
    ...shared,
    banner: {
      js: "import { createRequire as __tnegaCreateRequire } from 'node:module'; const require = __tnegaCreateRequire(import.meta.url);",
    },
    entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('../out/main.js', import.meta.url)),
  }),
  build({
    ...shared,
    // Sandboxed Electron preloads run as CommonJS with a restricted require.
    // The main-process ESM/createRequire banner cannot run in this context.
    format: 'cjs',
    entryPoints: [fileURLToPath(new URL('../src/preload.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('../out/preload.js', import.meta.url)),
  }),
])
