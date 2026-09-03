import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import type { Task } from '@tnega/eval'

import { saveManifest, writeTasksFile } from './manifest.js'
import { downloadParquet, readParquetRows } from './parquet.js'
import { importsOnlyStdlib } from './stdlib.js'
import type {
  BenchmarkImportOptions,
  BenchmarkManifest,
  BenchmarkTask,
  ImportedBenchmark,
} from './types.js'

const MBPP_DATASET = 'google-research-datasets/mbpp'
const DEFAULT_VERSION = 'full-test-v1'
const PARQUET_PATH = 'full/test-00000-of-00001.parquet'

interface MbppRow {
  task_id: number
  text: string
  code: string
  test_list: string[]
  test_setup_code?: string
}

export interface MbppFixture {
  solution: string
  test: string
}

export function buildMbppFixture(row: {
  test_list: readonly string[]
  test_setup_code?: string
}): MbppFixture {
  const cases = (row.test_list ?? []).map((testCase, index) => [
    `    def test_${index}(self):`,
    ...indentLines(testCase, 8),
  ].join('\n'))
  const test = [
    'import unittest',
    'from solution import *',
    '',
    ...(row.test_setup_code?.trim() ? [row.test_setup_code.trim(), ''] : []),
    'class MbppTest(unittest.TestCase):',
    cases.join('\n\n'),
    '',
    'if __name__ == "__main__":',
    '    unittest.main()',
    '',
  ].join('\n')
  return {
    solution: 'pass\n',
    test,
  }
}

export async function importMbpp(
  options: BenchmarkImportOptions,
): Promise<ImportedBenchmark> {
  const version = options.version ?? DEFAULT_VERSION
  const mirror = options.mirror ?? 'https://hf-mirror.com'
  const rawFile = join(options.outDir, '.cache', 'mbpp-full-test.parquet')
  await downloadParquet(
    `${mirror}/datasets/${MBPP_DATASET}/resolve/main/${PARQUET_PATH}`,
    rawFile,
    options.force ?? false,
  )
  const rows = await readParquetRows<MbppRow>(rawFile)
  const eligible = rows
    .filter(row => importsOnlyStdlib(row.code, row.test_setup_code ?? ''))
    .slice(0, options.subset ?? 500)

  const tasks: BenchmarkTask[] = []
  for (const row of eligible) {
    const instanceId = `MBPP/${row.task_id}`
    const taskId = safeTaskId(instanceId)
    const fixtureDir = join(options.outDir, 'mbpp', taskId)
    await mkdir(fixtureDir, { recursive: true })
    const fixture = buildMbppFixture(row)
    await writeFile(join(fixtureDir, 'solution.py'), fixture.solution, 'utf8')
    await writeFile(join(fixtureDir, 'test_solution.py'), fixture.test, 'utf8')
    const task: Task = {
      id: instanceId,
      name: instanceId,
      inputText: [
        row.text.trim(),
        '',
        'Implement the requested function in solution.py so that all tests pass.',
        'The file already contains a "pass" stub; replace it with a complete implementation. Do not modify test_solution.py.',
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
        dataset: 'mbpp',
        instanceId,
        version,
        testCount: (row.test_list ?? []).length,
      },
    }
    tasks.push({
      task,
      meta: {
        dataset: 'mbpp',
        instanceId,
        version,
        testCount: (row.test_list ?? []).length,
      },
      fixtureDir,
    })
  }

  const tasksFile = await writeTasksFile(
    options.outDir,
    tasks.map(({ task, meta }) => ({ task, meta })),
  )
  const manifest: BenchmarkManifest = {
    source: 'mbpp',
    version,
    importedAt: Date.now(),
    total: tasks.length,
    tasks: tasks.map(({ task, fixtureDir }) => ({
      id: task.id,
      fixtureDir,
      taskFile: tasksFile,
      dataset: 'mbpp',
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

function indentLines(source: string, width: number): string[] {
  const padding = ' '.repeat(width)
  return source.split(/\r?\n/).map(line => line ? `${padding}${line}` : '')
}

function safeTaskId(taskId: string): string {
  return taskId.replaceAll('/', '-')
}
