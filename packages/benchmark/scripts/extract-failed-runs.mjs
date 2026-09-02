#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const root = resolve(scriptDir, '..', '..', '..')
const dataDir = join(root, 'data', 'benchmarks')
const args = parseArgs(process.argv.slice(2))
const runsDir = resolve(args.runsDir)
const outDir = resolve(args.out)
const tasksFile = join(dataDir, 'tasks.json')
const traceRoot = join(root, '.tnega', 'runs')

const parsedTasks = JSON.parse(await readFile(tasksFile, 'utf8'))
const tasksById = new Map((parsedTasks.tasks ?? []).map(task => [task.id, task]))
const validIds = args.valid ? await readValidIds() : undefined
const runs = await collectRuns(runsDir)
const drafts = []

for (const run of runs) {
  const taskId = run.taskIds?.[0]
  if (!taskId) continue
  if (validIds && !validIds.has(taskId)) continue
  if ((run.summary?.budget?.turns ?? 0) === 0) continue
  const check = run.verdicts?.find(verdict => verdict.strategy === 'check')
  if (check?.status !== 'fail') continue
  const task = tasksById.get(taskId)
  if (!task) continue
  const traceFile = join(traceRoot, run.id, 'traces', `${taskId}-1.jsonl`)
  const trace = await readTrace(traceFile)
  const lastWrite = lastWriteFile(trace)
  const finalOutput = lastEvent(trace, 'turn/end')?.payload?.output
  const draft = {
    task: {
      id: `draft-${task.artifacts?.dataset ?? 'unknown'}-${safeId(taskId)}`,
      name: `draft: ${task.name ?? taskId}`,
      inputText: [
        task.inputText ?? '',
        '',
        'A previous attempt failed this task. Review the trace and produce a corrected implementation.',
        '',
        ...(finalOutput ? ['Previous final output:', finalOutput, ''] : []),
        ...(lastWrite
          ? ['Last attempted solution.py:', '```python', lastWrite.content, '```']
          : []),
      ].join('\n'),
      fixture: task.fixture,
      check: task.check,
      trials: 1,
      split: 'val',
      permissions: task.permissions,
      artifacts: {
        ...(task.artifacts ?? {}),
        draft: true,
        sourceRun: run.id,
        failureReason: check.reason ?? '',
        finalOutput,
        toolErrors: trace.filter(event =>
          event.type === 'tool/result' && event.payload?.ok === false,
        ).length,
        traceFile: relative(root, traceFile),
      },
    },
    review: {
      taskId,
      dataset: task.artifacts?.dataset,
      sourceRun: run.id,
      createdAt: run.createdAt,
      failureReason: check.reason ?? '',
      turns: run.summary?.budget?.turns,
      tokens: run.summary?.budget?.tokens,
      lastWriteFile: lastWrite?.path,
      finalOutput,
    },
  }
  drafts.push(draft)
  const file = join(outDir, draft.task.artifacts.dataset ?? 'unknown', `${safeId(taskId)}.json`)
  await mkdir(join(outDir, draft.task.artifacts.dataset ?? 'unknown'), { recursive: true })
  await writeFile(file, `${JSON.stringify(draft, null, 2)}\n`, 'utf8')
}

const summaryFile = join(outDir, '_draft-summary.json')
await writeFile(
  summaryFile,
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    runsScanned: runs.length,
    drafts: drafts.map(draft => draft.review),
  }, null, 2)}\n`,
  'utf8',
)
console.log(`scanned ${runs.length} runs, wrote ${drafts.length} drafts to ${outDir}`)
console.log(JSON.stringify(drafts.map(draft => draft.review), null, 2))

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

async function readTrace(file) {
  const text = await readFile(file, 'utf8').catch(() => '')
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function lastWriteFile(events) {
  let last
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const payload = event.payload ?? {}
    if (payload.name !== 'write_file') continue
    const args = payload.arguments ?? {}
    if (args.path?.endsWith('solution.py') && typeof args.content === 'string') {
      last = { path: args.path, content: args.content }
    }
  }
  return last
}

function lastEvent(events, type) {
  return [...events].reverse().find(event => event.type === type)
}

function safeId(id) {
  return id.replaceAll(/[/\\]/g, '-')
}

function relative(from, to) {
  const rel = resolve(to).replaceAll('\\', '/')
  const base = resolve(from).replaceAll('\\', '/')
  return rel.startsWith(`${base}/`) ? rel.slice(base.length + 1) : rel
}

function parseArgs(values) {
  const parsed = {
    runsDir: join(dataDir, 'runs'),
    out: join(dataDir, 'drafts'),
    valid: false,
  }
  let cursor = 0
  while (cursor < values.length) {
    const arg = values[cursor]
    if (arg === '--valid') {
      parsed.valid = true
      cursor += 1
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2)
    const value = eq >= 0 ? arg.slice(eq + 1) : values[cursor + 1]
    if (!value) throw new Error(`--${name} requires a value`)
    if (name === 'runs-dir') parsed.runsDir = value
    else if (name === 'out') parsed.out = value
    else throw new Error(`unknown option: --${name}`)
    cursor += eq >= 0 ? 1 : 2
  }
  return parsed
}

async function readValidIds() {
  const files = {
    bigcodebench: 'verified-bigcodebench.json',
    humaneval: 'verified-humaneval.json',
    mbpp: 'verified-mbpp.json',
    swebench: 'verified-swebench.json',
  }
  const valid = new Set()
  for (const [dataset, file] of Object.entries(files)) {
    const verified = JSON.parse(await readFile(join(dataDir, file), 'utf8'))
    for (const row of verified) {
      const ok = dataset === 'swebench'
        ? row.basePass === false && row.goldPass === true
        : row.goldPass === true
      if (ok) valid.add(row.instanceId)
    }
  }
  return valid
}
