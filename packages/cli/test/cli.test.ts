import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CliError,
  compareCommand,
  formatCompare,
  formatRun,
  loadTasksFile,
  main,
  parseYaml,
  runCommand,
} from '../src/index.js'
import type { EvalRun } from '../src/index.js'

const dirs: string[] = []
let stdoutSpy: ReturnType<typeof vi.spyOn> | undefined

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  stdoutSpy?.mockRestore()
  stdoutSpy = undefined
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function captureStdout(): () => string {
  let output = ''
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((
    chunk: string | Uint8Array,
  ) => {
    output += String(chunk)
    return true
  })
  return () => output
}

async function writeTasks(
  dir: string,
  file: string,
  overrides: Partial<{
    outputDir: string
    inputText: string
    expect: string
    taskId: string
    candidates: string
  }> = {},
): Promise<string> {
  const taskId = overrides.taskId ?? 'echo-good'
  const inputText = overrides.inputText ?? 'good'
  const expected = overrides.expect ?? 'good'
  const candidates = overrides.candidates ?? `
  echo:
    version: "1"
    loop: echo
`
  const text = [
    `outputDir: ${overrides.outputDir ?? '.tnega/runs'}`,
    'tasks:',
    `  - id: ${taskId}`,
    `    inputText: ${inputText}`,
    '    assertion:',
    `      expect: ${expected}`,
    'strategyNames:',
    '  - assert',
    'candidates:',
    candidates,
    'defaultCandidate: echo',
  ].join('\n')
  const target = join(dir, file)
  await writeFile(target, text, 'utf8')
  return target
}

describe('parseYaml and loadTasksFile', () => {
  it('parses tasks, candidates, strategies and assertions', () => {
    const data = parseYaml(`
# eval tasks
outputDir: runs
tasks:
  - id: echo-good
    inputText: good
    assertion:
      expect: good
strategyNames:
  - assert
  - gate
candidates:
  echo:
    version: "1"
    loop: echo
  empty:
    version: "2"
defaultCandidate: echo
`)

    expect(data).toMatchObject({
      outputDir: 'runs',
      tasks: [
        {
          id: 'echo-good',
          inputText: 'good',
          assertion: { expect: 'good' },
        },
      ],
      strategyNames: ['assert', 'gate'],
      candidates: {
        echo: { version: '1', loop: 'echo' },
        empty: { version: '2' },
      },
      defaultCandidate: 'echo',
    })
  })

  it('loads a tasks file from disk and rejects files without tasks', async () => {
    const dir = await tempDir('tnega-cli-load-')
    const tasksFile = await writeTasks(dir, 'tasks.yml')
    const loaded = loadTasksFile(tasksFile)

    expect(loaded.tasks).toHaveLength(1)
    expect(loaded.tasks[0]).toMatchObject({
      id: 'echo-good',
      inputText: 'good',
      assertion: { expect: 'good' },
    })
    expect(loaded.strategyNames).toEqual(['assert'])
    expect(loaded.outputDir).toBe('.tnega/runs')
    expect(loaded.candidates).toMatchObject({
      echo: { version: '1', loop: 'echo' },
    })

    const empty = join(dir, 'empty.yml')
    await writeFile(empty, 'strategyNames:\n  - assert\n', 'utf8')
    expect(() => loadTasksFile(empty)).toThrow(CliError)
  })
})

describe('eval run command', () => {
  it('runs echo candidates, persists the run and reloads it via compare', async () => {
    const dir = await tempDir('tnega-cli-run-')
    const tasksFile = await writeTasks(dir, 'tasks.yml')
    const run = await runCommand({ tasksFile, cwd: dir })

    expect(run.candidate.name).toBe('echo')
    expect(run.candidate.version).toBe('1')
    expect(run.summary.passed).toBe(1)
    expect(run.summary.failed).toBe(0)
    expect(run.summary.score).toBe(1)
    expect(run.verdicts.map(verdict => verdict.taskId)).toEqual(['echo-good'])

    const runFile = join(dir, '.tnega', 'runs', `${run.id}.json`)
    const saved = JSON.parse(await readFile(runFile, 'utf8')) as EvalRun
    expect(saved.id).toBe(run.id)
    expect(saved.verdicts).toEqual(run.verdicts)

    const result = await compareCommand({
      base: run.id,
      head: run.id,
      outputDir: join(dir, '.tnega', 'runs'),
      cwd: dir,
    })
    expect(result.summary.delta).toBe(0)
    expect(result.taskResults[0]!.changed).toBe(false)
  })

  it('reuses cache and respects --no-cache', async () => {
    const dir = await tempDir('tnega-cli-cache-')
    const tasksFile = await writeTasks(dir, 'tasks.yml')

    const first = await runCommand({ tasksFile, cwd: dir })
    const second = await runCommand({ tasksFile, cwd: dir })
    const uncached = await runCommand({ tasksFile, cwd: dir, cache: false })

    expect(first.cacheHits).toBe(0)
    expect(second.cacheHits).toBe(1)
    expect(uncached.cacheHits).toBe(0)
  })

  it('reports a failed run through main with a nonzero exit code', async () => {
    const dir = await tempDir('tnega-cli-main-fail-')
    const tasksFile = await writeTasks(dir, 'tasks.yml', {
      inputText: 'bad',
      expect: 'good',
    })
    const output = captureStdout()
    const code = await main([
      'eval',
      'run',
      tasksFile,
      '--candidate',
      'echo',
      '--no-cache',
      '--cwd',
      dir,
    ])

    expect(code).toBe(1)
    expect(output()).toContain('score 0.000')
    expect(output()).toContain('(0 passed, 1 failed')
  })
})

describe('eval compare command', () => {
  it('reports improvements, regressions and delta through main', async () => {
    const dir = await tempDir('tnega-cli-compare-')
    const baseFile = await writeTasks(dir, 'base.yml', {
      taskId: 'echo-task',
      inputText: 'bad',
      expect: 'good',
    })
    const headFile = await writeTasks(dir, 'head.yml', {
      taskId: 'echo-task',
      inputText: 'good',
      expect: 'good',
    })
    const base = await runCommand({ tasksFile: baseFile, cwd: dir })
    const head = await runCommand({ tasksFile: headFile, cwd: dir })

    const output = captureStdout()
    const improved = await main(['eval', 'compare', base.id, head.id, '--cwd', dir])
    expect(improved).toBe(0)
    expect(output()).toContain(`base ${base.id}: 0.000`)
    expect(output()).toContain(`head ${head.id}: 1.000`)
    expect(output()).toContain('delta +1.000')
    expect(output()).toContain('improvement echo-task')

    const output2 = captureStdout()
    const regressed = await main(['eval', 'compare', head.id, base.id, '--cwd', dir])
    expect(regressed).toBe(1)
    expect(output2()).toContain('regression echo-task')
  })
})

describe('CLI errors and formatting', () => {
  it('returns error code for unknown commands and missing tasks files', async () => {
    const output = captureStdout()
    expect(await main(['nope'])).toBe(2)
    expect(output()).toContain('unknown command')
    expect(await main(['eval', 'run'])).toBe(2)
    expect(output()).toContain('eval run requires a tasks file')
  })

  it('formats run and compare output', async () => {
    const dir = await tempDir('tnega-cli-format-')
    const tasksFile = await writeTasks(dir, 'tasks.yml')
    const run = await runCommand({ tasksFile, cwd: dir })
    const result = await compareCommand({
      base: run.id,
      head: run.id,
      outputDir: join(dir, '.tnega', 'runs'),
      cwd: dir,
    })

    expect(formatRun(run)).toContain(`run ${run.id}`)
    expect(formatRun(run)).toContain('candidate echo@1')
    expect(formatCompare(result)).toContain(`base ${run.id}: 1.000`)
    expect(formatCompare(result)).toContain('delta +0.000')
  })
})
