import type { Task } from '@tnega/eval'

export type BenchmarkSource = 'bigcodebench' | 'swebench'

export interface BenchmarkImportOptions {
  /** Destination directory for the materialized benchmark. */
  outDir: string
  /** Number of tasks to import, default source-specific. */
  subset?: number
  /** Optional comma-separated repo filter for swebench, e.g. "psf/requests,sympy/sympy". */
  repo?: string
  /** Optional comma-separated instance filter for swebench, e.g. "psf__requests-6028". */
  ids?: string
  /** Dataset version, default latest known. */
  version?: string
  /** HuggingFace mirror base URL, default https://hf-mirror.com. */
  mirror?: string
  /** Force re-download of the raw parquet file. */
  force?: boolean
}

export interface BenchmarkTaskMeta {
  dataset: string
  instanceId: string
  version: string
  entryPoint?: string
  libs?: string[]
  repo?: string
  baseCommit?: string
  failToPass?: string[]
  passToPass?: string[]
}

export interface BenchmarkTask {
  task: Task
  meta: BenchmarkTaskMeta
  /** Directory containing the fixture workspace. */
  fixtureDir: string
}

export interface BenchmarkManifest {
  source: BenchmarkSource
  version: string
  importedAt: number
  total: number
  tasks: Array<{
    id: string
    fixtureDir: string
    taskFile: string
    dataset: BenchmarkSource
  }>
  sources?: Record<string, { version: string; total: number }>
}

export interface ImportedBenchmark {
  manifest: BenchmarkManifest
  tasksFile: string
  manifestFile: string
  dir: string
}
