#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'

const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const root = resolve(scriptDir, '..', '..', '..')
const dataDir = join(root, 'data', 'benchmarks')
const parquetFile = join(dataDir, '.cache', 'swebench-verified.parquet')
const ids = process.argv.slice(2).filter(arg => !arg.startsWith('--'))

const importedIds = await importedSwebenchIds()
const buffer = await asyncBufferFromFile(parquetFile)
const rows = await parquetReadObjects({ file: buffer })
const selectedRows = rows.filter(row =>
  ids.length ? ids.includes(row.instance_id) : importedIds.has(row.instance_id)
)

const results = []
const verified = await mapWithConcurrency(selectedRows, 6, async (row, index) => {
  const result = await verifyInstance(row)
  console.log(
    `[${index + 1}/${selectedRows.length}] ${result.instanceId}\tbase=${result.basePass ? 'PASS' : 'FAIL'}\tgold=${result.goldPass ? 'PASS' : 'FAIL'}\texit=${result.exitCode}\t${result.reason}`,
  )
  return result
})
results.push(...verified)

const outputFile = join(dataDir, 'verified-swebench.json')
await writeFile(outputFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
console.log(`wrote ${outputFile} (${results.length} instances)`)

async function importedSwebenchIds() {
  const tasksFile = join(dataDir, 'tasks.json')
  const parsed = JSON.parse(await readFile(tasksFile, 'utf8'))
  const ids = new Set()
  for (const task of parsed.tasks ?? []) {
    if (task.artifacts?.dataset === 'swebench') ids.add(task.id)
  }
  return ids
}

async function mapWithConcurrency(items, limit, worker) {
  const results = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await worker(item, index)
    }
  })
  await Promise.all(workers)
  return results
}

async function verifyInstance(row) {
  const instanceId = row.instance_id
  const snapshotDir = join(
    dataDir,
    '.cache',
    'repos',
    `${row.repo.replaceAll('/', '__')}-${row.base_commit}`,
  )
  const workDir = await mkdtemp(join(tmpdir(), 'tnega-swe-gold-'))
  try {
    await cp(snapshotDir, workDir, { recursive: true })
    await writeFile(join(workDir, 'test.patch'), row.test_patch ?? '', 'utf8')
    await writeFile(join(workDir, 'gold.patch'), row.patch ?? '', 'utf8')
    await run('git', ['apply', '--whitespace=nowarn', 'test.patch'], workDir)
    const baseOutcome = await runTestRunner(row, workDir)
    let goldOutcome = baseOutcome
    if (row.patch) {
      await run('git', ['apply', '--whitespace=nowarn', 'gold.patch'], workDir)
      goldOutcome = await runTestRunner(row, workDir)
    }
    return {
      instanceId,
      basePass: baseOutcome.code === 0,
      goldPass: goldOutcome.code === 0,
      baseExitCode: baseOutcome.code,
      exitCode: goldOutcome.code,
      reason: !goldOutcome.error && baseOutcome.code === 0
        ? 'base already passed; task not reproducible'
        : goldOutcome.error ?? '',
    }
  } catch (error) {
    return {
      instanceId,
      basePass: false,
      goldPass: false,
      baseExitCode: -1,
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

async function runTestRunner(row, workDir) {
  const runner = buildCheckRunner(row)
  await writeFile(join(workDir, '.tnega_run_tests.py'), runner, 'utf8')
  return run('python', ['.tnega_run_tests.py'], workDir, 180_000)
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

function buildCheckRunner(row) {
  const patchFiles = testFilesFromPatch(row.test_patch ?? '')
  const entries = [
    ...parseNodeList(row.FAIL_TO_PASS),
    ...parseNodeList(row.PASS_TO_PASS),
  ]
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

function testFilesFromPatch(patch) {
  return [...new Set(patchTargetPaths(patch))]
}

function patchTargetPaths(patch) {
  const paths = []
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('+++ ')) continue
    let target = line.slice(4).trim()
    if (target.startsWith('b/')) target = target.slice(2)
    else if (target.startsWith('a/')) target = target.slice(2)
    if (target.startsWith('"') && target.endsWith('"')) {
      target = target.slice(1, -1)
    }
    if (target && target !== '/dev/null') paths.push(target)
  }
  return [...new Set(paths)]
}

function parseNodeList(value) {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string')
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter(item => typeof item === 'string')
      : []
  } catch {
    return value.split(',').map(item => item.trim()).filter(Boolean)
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
