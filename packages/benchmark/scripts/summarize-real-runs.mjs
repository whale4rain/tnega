#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const root = resolve(scriptDir, '..', '..', '..')
const dataDir = join(root, 'data', 'benchmarks')
const runsDir = resolve(process.argv[2] ?? join(dataDir, 'runs'))
const tasksFile = join(dataDir, 'tasks.json')

const parsedTasks = JSON.parse(await readFile(tasksFile, 'utf8'))
const tasksById = new Map((parsedTasks.tasks ?? []).map(task => [task.id, task]))
const [bcbVerified, sweVerified, humanevalVerified, mbppVerified] = await Promise.all([
  readVerified(join(dataDir, 'verified-bigcodebench.json')),
  readVerified(join(dataDir, 'verified-swebench.json')),
  readVerified(join(dataDir, 'verified-humaneval.json')),
  readVerified(join(dataDir, 'verified-mbpp.json')),
])
const valid = new Map([
  ...[...bcbVerified]
    .filter(row => row.goldPass === true)
    .map(row => [row.instanceId, row]),
  ...[...humanevalVerified]
    .filter(row => row.goldPass === true)
    .map(row => [row.instanceId, row]),
  ...[...mbppVerified]
    .filter(row => row.goldPass === true)
    .map(row => [row.instanceId, row]),
  ...[...sweVerified]
    .filter(row => row.basePass === false && row.goldPass === true)
    .map(row => [row.instanceId, row]),
])

const runs = await collectRuns(runsDir)
const rows = []
const latestByTask = new Map()
for (const run of runs) {
  const taskId = run.taskIds?.[0]
  if (!taskId) continue
  const previous = latestByTask.get(taskId)
  if (!previous || (run.createdAt ?? 0) > (previous.createdAt ?? 0)) {
    latestByTask.set(taskId, run)
  }
}
for (const run of latestByTask.values()) {
  const taskId = run.taskIds?.[0]
  const task = tasksById.get(taskId)
  const check = run.verdicts?.find(verdict => verdict.strategy === 'check')
  const trace = run.verdicts?.find(verdict => verdict.strategy === 'trace')
  if (!task) continue
  rows.push({
    task: taskId,
    dataset: task.artifacts?.dataset,
    valid: valid.has(taskId),
    check: check?.status,
    trace: trace?.status,
    score: run.summary?.score,
    turns: run.summary?.budget?.turns,
    tokens: run.summary?.budget?.tokens,
    createdAt: run.createdAt,
  })
}

const summary = summarize(rows)
console.log(JSON.stringify({
  runsDir,
  totals: {
    runs: rows.length,
    uniqueTasks: new Set(rows.map(row => row.task)).size,
    validRuns: rows.filter(row => row.valid).length,
  },
  byDataset: summary.byDataset,
  overall: summary.overall,
  unverifiable: summary.unverifiable,
}, null, 2))

async function readVerified(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return []
  }
}

async function collectRuns(dir) {
  const runs = []
  const entries = await readdir(dir)
  for (const name of entries) {
    const file = join(dir, name)
    const info = await stat(file)
    if (info.isDirectory()) {
      runs.push(...await collectRuns(file))
      continue
    }
    if (!name.endsWith('.json') || name.startsWith('_')) continue
    try {
      runs.push(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      // ignore malformed or non-run json files
    }
  }
  return runs
}

function summarize(rows) {
  const datasets = [...new Set(rows.map(row => row.dataset))]
  const byDataset = {}
  for (const dataset of datasets) {
    const group = rows.filter(row => row.dataset === dataset)
    byDataset[dataset] = stats(group)
  }
  return {
    byDataset,
    overall: stats(rows),
    unverifiable: rows
      .filter(row => !row.valid)
      .map(row => row.task)
      .sort(),
  }
}

function stats(rows) {
  const validRows = rows.filter(row => row.valid)
  const checks = validRows.filter(row => row.check === 'pass')
  const traces = validRows.filter(row => row.trace === 'pass')
  return {
    runs: rows.length,
    validRuns: validRows.length,
    checkPass: checks.length,
    checkRate: validRows.length ? checks.length / validRows.length : 0,
    tracePass: traces.length,
    traceRate: validRows.length ? traces.length / validRows.length : 0,
    meanScore: validRows.length
      ? validRows.reduce((sum, row) => sum + (row.score ?? 0), 0) / validRows.length
      : 0,
  }
}
