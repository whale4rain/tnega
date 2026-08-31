/* global URL */

import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
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
  entryPoints: ['src/index.ts'],
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

const tscPath = fileURLToPath(
  new URL('../node_modules/typescript/lib/tsc.js', import.meta.url),
)
const declarations = spawnSync(
  process.execPath,
  [tscPath, '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' },
)
if (declarations.status !== 0) {
  throw new Error(
    `declaration build failed with status ${declarations.status ?? 'unknown'}`,
  )
}

await rewriteDeclarationImports()

async function rewriteDeclarationImports() {
  const root = fileURLToPath(new URL('../dist/types/', import.meta.url))
  const files = await collectTypeFiles(root)
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    const rewritten = text.replace(/['"]@tnega\/([^'"]+)['"]/g, (match, spec) => {
      const target = join(root, 'packages', spec, 'src/index.js')
      const path = relative(dirname(file), target).replaceAll('\\', '/')
      return JSON.stringify(path)
    })
    if (rewritten !== text) await writeFile(file, rewritten)
  }
}

async function collectTypeFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectTypeFiles(path))
    } else if (entry.name.endsWith('.d.ts')) {
      files.push(path)
    }
  }
  return files
}
