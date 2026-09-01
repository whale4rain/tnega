import { access, mkdir, writeFile } from 'node:fs/promises'
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

const BIGCODEBENCH_DATASET = 'bigcode/bigcodebench'
const DEFAULT_VERSION = 'v0.1.4'

const STDLIB = new Set([
  'abc',
  'argparse',
  'array',
  'asyncio',
  'base64',
  'binascii',
  'bisect',
  'builtins',
  'calendar',
  'cmath',
  'collections',
  'configparser',
  'concurrent',
  'contextlib',
  'contextvars',
  'copy',
  'csv',
  'dataclasses',
  'datetime',
  'decimal',
  'difflib',
  'dis',
  'doctest',
  'enum',
  'errno',
  'fnmatch',
  'fractions',
  'functools',
  'gc',
  'glob',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'http',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'logging',
  'math',
  'marshal',
  'mmap',
  'multiprocessing',
  'numbers',
  'operator',
  'os',
  'pathlib',
  'pickle',
  'platform',
  'pprint',
  'queue',
  'random',
  're',
  'reprlib',
  'select',
  'shelve',
  'shutil',
  'signal',
  'socket',
  'sqlite3',
  'ssl',
  'stat',
  'statistics',
  'string',
  'struct',
  'subprocess',
  'sys',
  'tarfile',
  'tempfile',
  'textwrap',
  'threading',
  'time',
  'token',
  'tokenize',
  'traceback',
  'types',
  'typing',
  'unittest',
  'unicodedata',
  'urllib',
  'uuid',
  'weakref',
  'webbrowser',
  'zlib',
  'zipfile',
  'mock',
  'pytest',
  'solution',
])

interface BigCodeBenchRow {
  task_id: string
  complete_prompt: string
  instruct_prompt: string
  test: string
  entry_point: string
  libs: string
}

function parseLibs(value: string | undefined): string[] {
  if (!value) return []
  const libs: string[] = []
  for (const match of value.matchAll(/'([^']*)'/g)) {
    libs.push(match[1]!)
  }
  return libs
}

function isStdlibOnly(libs: readonly string[]): boolean {
  return libs.every(lib => STDLIB.has(lib))
}

export function isBigCodeBenchEligible(row: { libs?: string; test?: string }): boolean {
  return (
    isStdlibOnly(parseLibs(row.libs))
    && testImports(row.test ?? '').every(lib => STDLIB.has(lib))
  )
}

function testImports(test: string): string[] {
  const modules: string[] = []
  for (const match of test.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm)) {
    const name = match[1]!
    modules.push(name.split('.')[0]!)
  }
  return modules
}

function safeTaskId(taskId: string): string {
  return taskId.replaceAll('/', '-')
}

export async function importBigCodeBench(
  options: BenchmarkImportOptions,
): Promise<ImportedBenchmark> {
  const version = options.version ?? DEFAULT_VERSION
  const mirror = options.mirror ?? 'https://hf-mirror.com'
  const rawFile = join(options.outDir, '.cache', `bigcodebench-${version}.parquet`)
  await downloadParquet(
    `${mirror}/datasets/${BIGCODEBENCH_DATASET}/resolve/main/data/${version}-00000-of-00001.parquet`,
    rawFile,
    options.force ?? false,
  )
  const rows = await readParquetRows<BigCodeBenchRow>(rawFile)
  const eligible = rows
    .filter(row => isBigCodeBenchEligible(row))
    .slice(0, options.subset ?? 200)

  const tasks: BenchmarkTask[] = []
  for (const row of eligible) {
    const taskId = safeTaskId(row.task_id)
    const fixtureDir = join(options.outDir, 'bigcodebench', taskId)
    await mkdir(fixtureDir, { recursive: true })
    const solution = `${row.complete_prompt.trimEnd()}\n    pass\n`
    const testFile = `from solution import *\n\n${row.test.trim()}\n\nif __name__ == "__main__":\n    import unittest\n    unittest.main()\n`
    await writeFile(join(fixtureDir, 'solution.py'), solution, 'utf8')
    await writeFile(join(fixtureDir, 'test_solution.py'), testFile, 'utf8')
    const task: Task = {
      id: row.task_id,
      name: row.task_id,
      inputText: [
        row.instruct_prompt || [
          `Implement ${row.entry_point} in solution.py so that all tests pass.`,
          '',
          row.complete_prompt,
        ].join('\n'),
        '',
        `Implement ${row.entry_point} in solution.py. The file already contains a "pass" stub; replace it with a complete implementation. Do not modify test_solution.py.`,
        'Run the tests with: python -m unittest discover -s . -p "test_*.py" -v',
      ].join('\n'),
      fixture: { root: relative(options.outDir, fixtureDir) },
      check: 'python -m unittest discover -s . -p "test_*.py" -v',
      trials: 1,
      split: 'val',
      permissions: {
        shell: { enabled: true, allow: ['python', 'python3'] },
        network: false,
      },
      artifacts: {
        dataset: 'bigcodebench',
        instanceId: row.task_id,
        version,
        entryPoint: row.entry_point,
        libs: parseLibs(row.libs),
      },
    }
    tasks.push({
      task,
      meta: {
        dataset: 'bigcodebench',
        instanceId: row.task_id,
        version,
        entryPoint: row.entry_point,
        libs: parseLibs(row.libs),
      },
      fixtureDir,
    })
  }

  const tasksFile_ = await writeTasksFile(
    options.outDir,
    tasks.map(({ task, meta }) => ({ task, meta })),
  )
  const manifest: BenchmarkManifest = {
    source: 'bigcodebench',
    version,
    importedAt: Date.now(),
    total: tasks.length,
    tasks: tasks.map(({ task, fixtureDir }) => ({
      id: task.id,
      fixtureDir,
      taskFile: tasksFile_,
      dataset: 'bigcodebench',
    })),
  }
  const manifestFile_ = await saveManifest(options.outDir, manifest)
  return {
    manifest,
    tasksFile: tasksFile_,
    manifestFile: manifestFile_,
    dir: options.outDir,
  }
}

async function downloadParquet(url: string, file: string, force: boolean): Promise<void> {
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
