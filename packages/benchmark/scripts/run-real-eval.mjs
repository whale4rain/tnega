#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const root = resolve(scriptDir, '..', '..', '..')
const dataDir = join(root, 'data', 'benchmarks')
const tasksFile = join(dataDir, 'tasks.json')
const defaultRunsDir = join(dataDir, 'runs')

const args = parseArgs(process.argv.slice(2))
const tasks = (JSON.parse(await readFile(tasksFile, 'utf8'))).tasks ?? []
const candidates = tasks
  .filter(task => args.dataset ? task.artifacts?.dataset === args.dataset : true)
  .filter(task => args.repo ? task.artifacts?.repo === args.repo : true)
  .filter(task => args.ids.size ? args.ids.has(task.id) : true)
  .sort((a, b) => a.id.localeCompare(b.id))

const runsDir = resolve(args.runsDir)
await mkdir(runsDir, { recursive: true })
const existing = args.force
  ? new Set()
  : await existingTaskIds(runsDir)
const selected = candidates
  .filter(task => !existing.has(task.id))
  .slice(0, args.limit)

if (!selected.length) {
  console.log('no unrun tasks to evaluate')
  process.exit(0)
}

console.log(`evaluating ${selected.length} tasks (dataset=${args.dataset ?? 'all'}, limit=${args.limit ?? 'none'})`)
const rows = []
let failed = 0
for (const task of selected) {
  const output = join(runsDir, `${safeId(task.id)}.json`)
  const startedAt = Date.now()
  const result = await runCli([
    'eval', 'run', tasksFile,
    '--task', task.id,
    '--output', output,
  ])
  const durationMs = Date.now() - startedAt
  let run
  try {
    run = JSON.parse(await readFile(output, 'utf8'))
  } catch {
    run = undefined
  }
  const check = run?.verdicts?.find(verdict => verdict.strategy === 'check')
  const trace = run?.verdicts?.find(verdict => verdict.strategy === 'trace')
  const ok = result.code === 0 && check?.status === 'pass'
  if (!ok) failed += 1
  rows.push({
    task: task.id,
    ok,
    check: check?.status,
    trace: trace?.status,
    score: run?.summary?.score,
    turns: run?.summary?.budget?.turns,
    tokens: run?.summary?.budget?.tokens,
    durationMs,
    stderr: result.stderr.trim().slice(0, 500),
  })
  console.log(
    `${ok ? 'PASS' : 'FAIL'}\t${task.id}\tcheck=${check?.status ?? '-'}\ttrace=${trace?.status ?? '-'}\tturns=${run?.summary?.budget?.turns ?? '-'}\ttokens=${run?.summary?.budget?.tokens ?? '-'}\t${durationMs}ms`,
  )
}

const summary = {
  ranAt: new Date().toISOString(),
  dataset: args.dataset,
  total: rows.length,
  passed: rows.filter(row => row.ok).length,
  failed: rows.filter(row => !row.ok).length,
  tasks: rows,
}
const summaryFile = join(runsDir, '_batch-summary.json')
await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
console.log(`wrote ${summaryFile}`)
process.exit(failed ? 1 : 0)

function runCli(args_) {
  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--experimental-strip-types',
        '--experimental-transform-types',
        '--experimental-loader',
        './scripts/ts-import-loader.mjs',
        'scripts/tnega.ts',
        ...args_,
      ],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', error => {
      resolve({ code: 1, stderr: error.message, stdout })
    })
    child.on('close', code => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function existingTaskIds(dir) {
  const ids = new Set()
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue
    try {
      const run = JSON.parse(await readFile(join(dir, name), 'utf8'))
      for (const taskId of run.taskIds ?? []) ids.add(taskId)
    } catch {
      // ignore malformed or non-run json files
    }
  }
  return ids
}

function parseArgs(values) {
  const parsed = {
    dataset: undefined,
    repo: undefined,
    limit: undefined,
    runsDir: defaultRunsDir,
    force: false,
    ids: new Set(),
  }
  let cursor = 0
  while (cursor < values.length) {
    const arg = values[cursor]
    if (arg === '--force') {
      parsed.force = true
      cursor += 1
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2)
    const value = eq >= 0 ? arg.slice(eq + 1) : values[cursor + 1]
    if (!value) throw new Error(`--${name} requires a value`)
    if (name === 'dataset') parsed.dataset = value
    else if (name === 'repo') parsed.repo = value
    else if (name === 'limit') parsed.limit = Number(value)
    else if (name === 'runs-dir') parsed.runsDir = value
    else if (name === 'ids') parsed.ids = new Set(value.split(',').map(item => item.trim()).filter(Boolean))
    else throw new Error(`unknown option: --${name}`)
    cursor += eq >= 0 ? 1 : 2
  }
  return parsed
}

function safeId(id) {
  return id.replaceAll('/', '-')
}
