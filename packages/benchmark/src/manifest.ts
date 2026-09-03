import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { BenchmarkManifest } from './types.js'

export async function saveManifest(
  dir: string,
  manifest: BenchmarkManifest,
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'manifest.json')
  const previousText = await readFile(file, 'utf8').catch(() => undefined)
  const next = previousText
    ? mergeManifest(JSON.parse(previousText) as BenchmarkManifest, manifest)
    : manifest
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return file
}

function mergeManifest(
  previous: BenchmarkManifest,
  incoming: BenchmarkManifest,
): BenchmarkManifest {
  const byId = new Map<string, BenchmarkManifest['tasks'][number]>()
  for (const entry of previous.tasks) {
    const dataset = entry.dataset ?? previous.source
    if (dataset === incoming.source) continue
    byId.set(`${dataset}:${entry.id}`, { ...entry, dataset })
  }
  for (const entry of incoming.tasks) {
    byId.set(`${entry.dataset}:${entry.id}`, entry)
  }
  const tasks = [...byId.values()]
  const sources: Record<string, { version: string; total: number }> = {
    ...(previous.sources
      ?? { [previous.source]: { version: previous.version, total: previous.total } }),
  }
  const incomingTotal = tasks.filter(task => task.dataset === incoming.source).length
  sources[incoming.source] = { version: incoming.version, total: incomingTotal }
  return {
    source: incoming.source,
    version: incoming.version,
    importedAt: Date.now(),
    total: tasks.length,
    tasks,
    sources,
  }
}

export async function loadManifest(file: string): Promise<BenchmarkManifest> {
  const text = await readFile(file, 'utf8')
  return JSON.parse(text) as BenchmarkManifest
}

export function manifestFile(dir: string): string {
  return join(dir, 'manifest.json')
}

export function tasksFile(dir: string): string {
  return join(dir, 'tasks.json')
}

export async function writeTasksFile(
  dir: string,
  tasks: Array<{ task: import('@tnega/eval').Task; meta: import('./types.js').BenchmarkTaskMeta }>,
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = tasksFile(dir)
  await writeFile(file, `${JSON.stringify({
    outputDir: '.tnega/runs',
    strategyNames: ['check', 'trace'],
    candidates: {
      deepseek: {
        coding: true,
        version: '0.2.0',
      },
    },
    defaultCandidate: 'deepseek',
    tasks: tasks.map(entry => entry.task),
  }, null, 2)}\n`, 'utf8')
  return file
}

export function ensureDirname(file: string): Promise<string> {
  return mkdir(dirname(file), { recursive: true }).then(() => file)
}
