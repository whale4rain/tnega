import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'

import type { Task } from '@tnega/eval'

import { saveManifest, writeTasksFile } from './manifest.js'
import type {
  BenchmarkImportOptions,
  BenchmarkManifest,
  BenchmarkTask,
  ImportedBenchmark,
} from './types.js'

const SWEBENCH_DATASET = 'SWE-bench/SWE-bench_Verified'
const DEFAULT_VERSION = 'verified'

interface SweBenchRow {
  repo: string
  instance_id: string
  base_commit: string
  test_patch: string
  problem_statement?: string
  version?: string
  FAIL_TO_PASS?: string | string[]
  PASS_TO_PASS?: string | string[]
}

interface PatchedFile {
  path: string
  content: string
}

export async function importSweBench(
  options: BenchmarkImportOptions,
): Promise<ImportedBenchmark> {
  const version = options.version ?? DEFAULT_VERSION
  const mirror = options.mirror ?? 'https://hf-mirror.com'
  const rawFile = join(options.outDir, '.cache', 'swebench-verified.parquet')
  await downloadFile(
    `${mirror}/datasets/${SWEBENCH_DATASET}/resolve/main/data/test-00000-of-00001.parquet`,
    rawFile,
    options.force ?? false,
  )
  const rows = await readParquetRows<SweBenchRow>(rawFile)
  const repoFilter = options.repo
    ? new Set(options.repo.split(',').map(item => item.trim()).filter(Boolean))
    : undefined
  const idFilter = options.ids
    ? new Set(options.ids.split(',').map(item => item.trim()).filter(Boolean))
    : undefined
  const selected = rows
    .filter(row => !repoFilter || repoFilter.has(row.repo))
    .filter(row => !idFilter || idFilter.has(row.instance_id))
    .slice(0, options.subset ?? 50)

  const tasks: BenchmarkTask[] = []
  for (const row of selected) {
    const snapshotDir = await ensureRepoSnapshot(options, row)
    const fixtureFiles = await patchedFixtureFiles(options, row, snapshotDir)
    const testNodes = testNodeIds(row)
    const checkRunner = buildCheckRunner(testNodes, row.test_patch)
    const task: Task = {
      id: row.instance_id,
      name: row.instance_id,
      inputText: [
        row.problem_statement?.trim() ?? '',
        '',
        'Fix the bug in the repository source code.',
        'Do not modify any test files and do not install packages.',
        `Run the relevant tests with: python .tnega_run_tests.py`,
      ].join('\n'),
      fixture: {
        root: relative(options.outDir, snapshotDir),
        files: [
          ...fixtureFiles,
          { path: '.tnega_run_tests.py', content: checkRunner },
        ],
      },
      check: 'python .tnega_run_tests.py',
      trials: 1,
      split: 'val',
      permissions: {
        shell: {
          enabled: true,
          allow: ['python', 'python3', 'pytest'],
        },
        network: false,
      },
      artifacts: {
        dataset: 'swebench',
        instanceId: row.instance_id,
        version: row.version ?? version,
        repo: row.repo,
        baseCommit: row.base_commit,
        failToPass: testNodes.failToPass,
        passToPass: testNodes.passToPass,
        testFiles: testFilesFromPatch(row.test_patch),
      },
    }
    tasks.push({
      task,
      meta: {
        dataset: 'swebench',
        instanceId: row.instance_id,
        version: row.version ?? version,
        repo: row.repo,
        baseCommit: row.base_commit,
        failToPass: testNodes.failToPass,
        passToPass: testNodes.passToPass,
      },
      fixtureDir: snapshotDir,
    })
  }

  const tasksFile = await writeTasksFile(
    options.outDir,
    tasks.map(({ task, meta }) => ({ task, meta })),
  )
  const manifest: BenchmarkManifest = {
    source: 'swebench',
    version,
    importedAt: Date.now(),
    total: tasks.length,
    tasks: tasks.map(({ task, fixtureDir }) => ({
      id: task.id,
      fixtureDir,
      taskFile: tasksFile,
      dataset: 'swebench',
    })),
  }
  const manifestFile = await saveManifest(options.outDir, manifest)
  return {
    manifest,
    tasksFile,
    manifestFile,
    dir: options.outDir,
  }
}

async function ensureRepoSnapshot(
  options: BenchmarkImportOptions,
  row: SweBenchRow,
): Promise<string> {
  const key = `${row.repo.replaceAll('/', '__')}-${row.base_commit}`
  const reposDir = join(options.outDir, '.cache', 'repos')
  const snapshotDir = join(reposDir, key)
  try {
    await access(join(snapshotDir, '.tnega-snapshot'))
    return snapshotDir
  } catch {
    // snapshot missing, materialize below
  }

  const archiveDir = join(reposDir, 'archives')
  await mkdir(archiveDir, { recursive: true })
  const archive = join(archiveDir, `${key}.tar.gz`)
  try {
    await access(archive)
  } catch {
    await downloadFile(
      `https://codeload.github.com/${row.repo}/tar.gz/${row.base_commit}`,
      archive,
      false,
    )
  }

  const extractDir = join(reposDir, `.extract-${randomUUID()}`)
  await mkdir(extractDir, { recursive: true })
  try {
    await extractArchive(archive, extractDir)
    const top = await singleDirectory(extractDir)
    await mkdir(snapshotDir, { recursive: true })
    await cp(join(extractDir, top), snapshotDir, { recursive: true })
    await writeFile(join(snapshotDir, '.tnega-snapshot'), `${row.base_commit}\n`, 'utf8')
  } finally {
    await rm(extractDir, { recursive: true, force: true })
  }
  return snapshotDir
}

async function extractArchive(archive: string, destDir: string): Promise<void> {
  const script = [
    'import os,sys,tarfile',
    'src,dst=sys.argv[1],sys.argv[2]',
    'os.makedirs(dst,exist_ok=True)',
    'with tarfile.open(src,"r:gz") as t: t.extractall(dst, filter="data")',
  ].join('\n')
  await runCommand('python', ['-c', script, archive, destDir])
}

async function patchedFixtureFiles(
  options: BenchmarkImportOptions,
  row: SweBenchRow,
  snapshotDir: string,
): Promise<PatchedFile[]> {
  const targets = patchTargetPaths(row.test_patch)
  if (!targets.length) {
    throw new Error(`swebench instance ${row.instance_id} has no patch targets`)
  }
  const workDir = await mkdtemp(join(tmpdir(), 'tnega-swe-patch-'))
  try {
    const renames = patchRenamePairs(row.test_patch)
    const renamedTargets = new Set(renames.map(pair => pair.to))
    for (const target of targets) {
      if (renamedTargets.has(target)) continue
      const source = join(snapshotDir, target)
      const destination = join(workDir, target)
      try {
        await access(source)
        await mkdir(dirname(destination), { recursive: true })
        await cp(source, destination)
      } catch {
        await mkdir(dirname(destination), { recursive: true })
      }
    }
    for (const pair of renames) {
      const source = join(snapshotDir, pair.from)
      const destination = join(workDir, pair.from)
      await access(source)
      await mkdir(dirname(destination), { recursive: true })
      await cp(source, destination)
      const renamedFile = join(workDir, pair.to)
      if (renamedTargets.has(pair.to)) {
        await mkdir(dirname(renamedFile), { recursive: true })
      }
    }
    const patchFile = join(workDir, 'test.patch')
    await writeFile(patchFile, row.test_patch, 'utf8')
    await runCommand('git', ['apply', '--whitespace=nowarn', 'test.patch'], workDir)
    const files: PatchedFile[] = []
    for (const target of targets) {
      const content = await readFile(join(workDir, target), 'utf8')
      files.push({ path: target.replaceAll('\\', '/'), content })
    }
    return files
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

function testNodeIds(row: SweBenchRow): {
  failToPass: string[]
  passToPass: string[]
} {
  return {
    failToPass: parseNodeList(row.FAIL_TO_PASS),
    passToPass: parseNodeList(row.PASS_TO_PASS),
  }
}

function parseNodeList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return value.split(',').map(item => item.trim()).filter(Boolean)
  }
}

function buildCheckRunner(
  nodes: { failToPass: string[]; passToPass: string[] },
  testPatch: string,
): string {
  const patchFiles = testFilesFromPatch(testPatch)
  const entries = [...nodes.failToPass, ...nodes.passToPass]
  const nodeIds = entries.map(entry => {
    if (entry.includes('::')) return entry
    const file = patchFiles[0]
    return file ? `${file}::${entry}` : entry
  })
  return [
    'import pytest',
    '',
    `NODE_IDS = ${JSON.stringify(nodeIds, null, 2)}`,
    '',
    'if __name__ == "__main__":',
    '    raise SystemExit(pytest.main(["-q", *NODE_IDS]))',
    '',
  ].join('\n')
}

function testFilesFromPatch(testPatch: string): string[] {
  return [...new Set(patchTargetPaths(testPatch))]
}

function patchTargetPaths(patch: string): string[] {
  const paths: string[] = []
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('+++ ')) {
      let target = line.slice(4).trim()
      if (target.startsWith('b/')) target = target.slice(2)
      else if (target.startsWith('a/')) target = target.slice(2)
      if (target.startsWith('"') && target.endsWith('"')) {
        target = target.slice(1, -1)
      }
      if (target && target !== '/dev/null') paths.push(target)
    } else if (line.startsWith('rename to ')) {
      const target = line.slice('rename to '.length).trim()
      if (target) paths.push(target)
    }
  }
  return [...new Set(paths)]
}

function patchRenamePairs(patch: string): Array<{ from: string; to: string }> {
  const pairs: Array<{ from: string; to: string }> = []
  const lines = patch.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const fromLine = lines[i]!.trim()
    const toLine = lines[i + 1]?.trim() ?? ''
    if (
      fromLine.startsWith('rename from ') &&
      toLine.startsWith('rename to ')
    ) {
      pairs.push({
        from: fromLine.slice('rename from '.length).trim(),
        to: toLine.slice('rename to '.length).trim(),
      })
      i += 1
    }
  }
  return pairs
}

async function singleDirectory(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  const directories = entries.filter(entry => entry.isDirectory())
  if (directories.length !== 1) {
    throw new Error(`expected a single top-level directory in ${dir}`)
  }
  return directories[0]!.name
}

async function downloadFile(url: string, file: string, force: boolean): Promise<void> {
  try {
    await access(file)
    if (!force) return
  } catch {
    // file missing, download
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`failed to download ${url}: ${response.status} ${response.statusText}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, bytes)
}

async function readParquetRows<T>(file: string): Promise<T[]> {
  const buffer = await asyncBufferFromFile(file)
  const rows = await parquetReadObjects({ file: buffer })
  return rows as T[]
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', error => reject(error))
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited ${code ?? 1}\n${stdout}\n${stderr}`.trim()))
    })
  })
}
