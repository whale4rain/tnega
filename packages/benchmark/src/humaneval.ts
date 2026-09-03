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

const HUMANEVAL_DATASET = 'openai/openai_humaneval'
const DEFAULT_VERSION = 'v1'
const PARQUET_PATH = 'openai_humaneval/test-00000-of-00001.parquet'

interface HumanEvalRow {
  task_id: string
  prompt: string
  canonical_solution: string
  test: string
  entry_point: string
}

export interface HumanEvalFixture {
  solution: string
  test: string
}

export function buildHumanEvalFixture(row: {
  prompt: string
  test: string
  entry_point: string
}): HumanEvalFixture {
  const solution = `${row.prompt.trimEnd()}\n    pass\n`
  const test = [
    'from solution import *',
    '',
    'import unittest',
    '',
    row.test.trim(),
    '',
    'class HumanEvalTest(unittest.TestCase):',
    '    def test_entry_point(self):',
    `        check(${row.entry_point})`,
    '',
    'if __name__ == "__main__":',
    '    unittest.main()',
    '',
  ].join('\n')
  return { solution, test }
}

export async function importHumanEval(
  options: BenchmarkImportOptions,
): Promise<ImportedBenchmark> {
  const version = options.version ?? DEFAULT_VERSION
  const mirror = options.mirror ?? 'https://hf-mirror.com'
  const rawFile = join(options.outDir, '.cache', 'humaneval.parquet')
  await downloadParquet(
    `${mirror}/datasets/${HUMANEVAL_DATASET}/resolve/main/${PARQUET_PATH}`,
    rawFile,
    options.force ?? false,
  )
  const rows = await readParquetRows<HumanEvalRow>(rawFile)
  const eligible = rows
    .filter(row => importsOnlyStdlib(row.test))
    .slice(0, options.subset ?? 164)

  const tasks: BenchmarkTask[] = []
  for (const row of eligible) {
    const taskId = safeTaskId(row.task_id)
    const fixtureDir = join(options.outDir, 'humaneval', taskId)
    await mkdir(fixtureDir, { recursive: true })
    const fixture = buildHumanEvalFixture(row)
    await writeFile(join(fixtureDir, 'solution.py'), fixture.solution, 'utf8')
    await writeFile(join(fixtureDir, 'test_solution.py'), fixture.test, 'utf8')
    const task: Task = {
      id: row.task_id,
      name: row.task_id,
      inputText: [
        row.prompt.trimEnd(),
        '',
        `Implement ${row.entry_point} in solution.py so that all tests pass.`,
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
        dataset: 'humaneval',
        instanceId: row.task_id,
        version,
        entryPoint: row.entry_point,
      },
    }
    tasks.push({
      task,
      meta: {
        dataset: 'humaneval',
        instanceId: row.task_id,
        version,
        entryPoint: row.entry_point,
      },
      fixtureDir,
    })
  }

  const tasksFile = await writeTasksFile(
    options.outDir,
    tasks.map(({ task, meta }) => ({ task, meta })),
  )
  const manifest: BenchmarkManifest = {
    source: 'humaneval',
    version,
    importedAt: Date.now(),
    total: tasks.length,
    tasks: tasks.map(({ task, fixtureDir }) => ({
      id: task.id,
      fixtureDir,
      taskFile: tasksFile,
      dataset: 'humaneval',
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

function safeTaskId(taskId: string): string {
  return taskId.replaceAll('/', '-')
}
