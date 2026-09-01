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

const buffer = await asyncBufferFromFile(parquetFile)
const rows = await parquetReadObjects({ file: buffer })

const results = []
for (const row of rows) {
  if (ids.length && !ids.includes(row.instance_id)) continue
  const result = await verifyInstance(row)
  results.push(result)
  console.log(`${result.instanceId}\t${result.goldPass ? 'PASS' : 'FAIL'}\texit=${result.exitCode}\t${result.reason}`)
}

const outputFile = join(dataDir, 'verified-swebench.json')
await writeFile(outputFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
console.log(`wrote ${outputFile} (${results.length} instances)`)

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
    if (row.patch) {
      await run('git', ['apply', '--whitespace=nowarn', 'gold.patch'], workDir)
    }
    const runner = buildCheckRunner(row)
    await writeFile(join(workDir, '.tnega_run_tests.py'), runner, 'utf8')
    const outcome = await run('python', ['.tnega_run_tests.py'], workDir, 180_000)
    return {
      instanceId,
      goldPass: outcome.code === 0,
      exitCode: outcome.code,
      reason: outcome.error ?? '',
    }
  } catch (error) {
    return {
      instanceId,
      goldPass: false,
      exitCode: -1,
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
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
