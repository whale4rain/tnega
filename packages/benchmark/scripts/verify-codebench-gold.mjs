#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'

const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const root = resolve(scriptDir, '..', '..', '..')
const dataDir = join(root, 'data', 'benchmarks')
const dataset = process.argv[2]
if (dataset !== 'humaneval' && dataset !== 'mbpp') {
  console.error('usage: verify-codebench-gold.mjs <humaneval|mbpp>')
  process.exit(2)
}

const parquetFile = join(dataDir, '.cache', dataset === 'humaneval'
  ? 'humaneval.parquet'
  : 'mbpp-full-test.parquet')
const outputFile = join(dataDir, `verified-${dataset}.json`)
const fixtureRoot = join(dataDir, dataset)
const ids = await importedTaskIds(dataset)
const buffer = await asyncBufferFromFile(parquetFile)
const rows = await parquetReadObjects({ file: buffer })
const byId = new Map(rows.map(row => [instanceId(dataset, row), row]))
const selected = [...ids]
  .sort()
  .filter(id => byId.has(id))

const results = []
for (const id of selected) {
  const row = byId.get(id)
  const result = await verifyInstance(dataset, id, row)
  results.push(result)
  console.log(
    `${result.instanceId}\tgold=${result.goldPass ? 'PASS' : 'FAIL'}\texit=${result.exitCode}\t${result.reason}`,
  )
}

await writeFile(outputFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
console.log(`wrote ${outputFile} (${results.length} instances)`)

async function importedTaskIds(source) {
  const tasksFile = join(dataDir, 'tasks.json')
  const parsed = JSON.parse(await readFile(tasksFile, 'utf8'))
  const ids = new Set()
  for (const task of parsed.tasks ?? []) {
    if (task.artifacts?.dataset === source) ids.add(task.id)
  }
  return ids
}

function instanceId(source, row) {
  return source === 'humaneval' ? row.task_id : `MBPP/${row.task_id}`
}

async function verifyInstance(source, id, row) {
  const fixtureDir = join(fixtureRoot, id.replaceAll('/', '-'))
  const workDir = await mkdtemp(join(tmpdir(), `tnega-${source}-gold-`))
  try {
    await writeFile(
      join(workDir, 'test_solution.py'),
      await readFile(join(fixtureDir, 'test_solution.py'), 'utf8'),
      'utf8',
    )
    const solution = source === 'humaneval'
      ? `${row.prompt.trimEnd()}\n${row.canonical_solution ?? '    pass\n'}`
      : `${row.code.trimEnd()}\n`
    await writeFile(join(workDir, 'solution.py'), solution, 'utf8')
    const outcome = await run('python', [
      '-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py', '-v',
    ], workDir, 120_000)
    return {
      instanceId: id,
      goldPass: outcome.code === 0,
      exitCode: outcome.code,
      reason: outcome.error ?? '',
    }
  } catch (error) {
    return {
      instanceId: id,
      goldPass: false,
      exitCode: -1,
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    try {
      await rmRetry(workDir)
    } catch (error) {
      console.warn(`warning: could not remove ${workDir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function rmRetry(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 9) throw error
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
}

function run(command, args, cwd, timeoutMs = 60_000) {
  return new Promise(resolve => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish({ code: 124, error: 'timed out' })
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', error => {
      finish({ code: 1, error: error.message })
    })
    child.on('close', code => {
      finish({ code: code ?? 1, error: '' })
    })
    function finish(outcome) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const detail = outcome.error || `${stdout}\n${stderr}`.trim().slice(0, 500)
      resolve({ code: outcome.code, error: detail })
    }
  })
}

function killTree(pid) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    process.kill(-pid, 'SIGKILL')
  }
}
