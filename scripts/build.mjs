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
  banner: {
    js: "import { createRequire as __tnegaCreateRequire } from 'node:module'; const require = __tnegaCreateRequire(import.meta.url);",
  },
}

/**
 * 每个包的物理目录：发布子路径名 → 仓库内路径。
 *
 * `packages/search/` 是搜索缝三个角色的共同容器，所以这三个包不在 `packages/<name>`
 * 这一层。声明产物的重写（rewriteDeclarationImports）与库入口共用这张表。
 */
const packageDirs = {
  search: 'packages/search/search-definition',
  'search-ripgrep': 'packages/search/search-ripgrep',
  'tool-search': 'packages/search/tool-search',
  spill: 'packages/spill/spill',
  'spill-local': 'packages/spill/spill-local',
  'tool-spill': 'packages/spill/tool-spill',
  memory: 'packages/memory/memory',
  'memory-local': 'packages/memory/memory-local',
  'tool-memory': 'packages/memory/tool-memory',
  subagent: 'packages/subagent/subagent',
  'subagent-local': 'packages/subagent/subagent-local',
  'tool-subagent': 'packages/subagent/tool-subagent',
  // Project v2：每条缝的角色同样放在共同容器目录下。
  blackboard: 'packages/project/blackboard',
  'blackboard-local': 'packages/project/blackboard-local',
  'artifact-store': 'packages/project/artifact-store',
  'artifact-local': 'packages/project/artifact-local',
  project: 'packages/project/project',
  'project-local': 'packages/project/project-local',
  box: 'packages/project/box',
  'box-blackboard': 'packages/project/box-blackboard',
  thread: 'packages/project/thread',
  'thread-local': 'packages/project/thread-local',
}

const packageDir = (name) => packageDirs[name] ?? `packages/${name}`

const libraryEntries = {
  agent: 'packages/agent/src/index.ts',
  'coding-agent': 'packages/coding-agent/src/index.ts',
  core: 'packages/core/src/index.ts',
  eval: 'packages/eval/src/index.ts',
  evolve: 'packages/evolve/src/index.ts',
  execution: 'packages/execution/src/index.ts',
  llm: 'packages/llm/src/index.ts',
  memory: `${packageDir('memory')}/src/index.ts`,
  'memory-local': `${packageDir('memory-local')}/src/index.ts`,
  blackboard: `${packageDir('blackboard')}/src/index.ts`,
  'blackboard-local': `${packageDir('blackboard-local')}/src/index.ts`,
  'artifact-store': `${packageDir('artifact-store')}/src/index.ts`,
  'artifact-local': `${packageDir('artifact-local')}/src/index.ts`,
  project: `${packageDir('project')}/src/index.ts`,
  'project-local': `${packageDir('project-local')}/src/index.ts`,
  box: `${packageDir('box')}/src/index.ts`,
  'box-blackboard': `${packageDir('box-blackboard')}/src/index.ts`,
  thread: `${packageDir('thread')}/src/index.ts`,
  'thread-local': `${packageDir('thread-local')}/src/index.ts`,
  subagent: `${packageDir('subagent')}/src/index.ts`,
  'subagent-local': `${packageDir('subagent-local')}/src/index.ts`,
  search: `${packageDir('search')}/src/index.ts`,
  'search-ripgrep': `${packageDir('search-ripgrep')}/src/index.ts`,
  session: 'packages/session/src/index.ts',
  spill: `${packageDir('spill')}/src/index.ts`,
  'spill-local': `${packageDir('spill-local')}/src/index.ts`,
  'tool-spill': `${packageDir('tool-spill')}/src/index.ts`,
  'tool-search': `${packageDir('tool-search')}/src/index.ts`,
  'tool-memory': `${packageDir('tool-memory')}/src/index.ts`,
  'tool-subagent': `${packageDir('tool-subagent')}/src/index.ts`,
  tools: 'packages/tools/src/index.ts',
  'cli-runtime': 'packages/cli/src/index.ts',
  events: 'src/events.ts',
  services: 'src/services.ts',
}

await Promise.all([
  build({
    ...common,
    entryPoints: ['packages/cli/src/bin.ts'],
    outfile: 'dist/bin.js',
  }),
  build({
    ...common,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
  }),
  ...Object.entries(libraryEntries).map(([name, entryPoint]) =>
    build({
      ...common,
      entryPoints: [entryPoint],
      outfile: `dist/${name}.js`,
    }),
  ),
])
chmodSync(new URL('../dist/bin.js', import.meta.url), 0o755)

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
      const target = join(root, packageDir(spec), 'src/index.js')
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
