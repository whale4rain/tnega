import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { agent } from '@tnega/agent'
import { session } from '@tnega/session'
import { tools } from '@tnega/tools'

import {
  evalPlugin,
  EvalService,
  type EvalPluginConfig,
  type EvalRun,
  type Task,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function setupRoot(
  outputDir: string,
  evalConfig: Partial<EvalPluginConfig> = {},
): Promise<Context> {
  const root = new Context()
  await root.plugin(session, { file: join(outputDir, 'root-session.jsonl') })
  await root.plugin(tools)
  await root.plugin(agent)
  await root.plugin(evalPlugin, { outputDir, ...evalConfig })
  return root
}

function service(root: Context): EvalService {
  return dynamic(root).eval as EvalService
}

function task(id: string, inputText: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    inputText,
    ...extra,
  }
}

function candidateLoop(output: string, calls: number[] = []): {
  plugin: (ctx: Context) => void
  calls: number[]
} {
  return {
    plugin: (ctx: Context) => {
      ctx.provide('agentLoop', async (input?: { text?: string }) => {
        calls.push(1)
        return {
          input: input ?? {},
          output,
          finishReason: 'stop',
          steps: [],
          messages: [{ role: 'user', content: input?.text ?? '' }],
        }
      })
    },
    calls,
  }
}

describe('EvalService strategies', () => {
  it('registers, lists, gets and unregisters strategies', async () => {
    const root = new Context()
    await root.plugin(evalPlugin)
    const evalService = service(root)

    expect(evalService.listStrategies()).toContain('assert')
    const dispose = evalService.register({
      name: 'custom',
      evaluate: () => ({
        taskId: 't',
        strategy: 'custom',
        status: 'pass' as const,
        score: 1,
      }),
    })
    expect(evalService.getStrategy('custom')).toBeDefined()
    expect(evalService.unregister('custom')).toBe(true)
    expect(evalService.getStrategy('custom')).toBeUndefined()

    dispose()
    expect(evalService.getStrategy('custom')).toBeUndefined()
    expect(evalService.listStrategies()).not.toContain('custom')
  })

  it('rejects duplicate custom strategy names', async () => {
    const root = new Context()
    await root.plugin(evalPlugin)
    const evalService = service(root)
    expect(() => evalService.register({
      name: 'assert',
      evaluate: () => ({ taskId: 't', strategy: 'assert', status: 'pass', score: 1 }),
    })).toThrow(/already registered/)
  })

  it('runs a custom strategy through the runner', async () => {
    const dir = await tempDir('tnega-eval-custom-')
    const root = await setupRoot(dir)
    const evalService = service(root)
    evalService.register({
      name: 'shout',
      evaluate: (_ctx, _task, evidence) => ({
        taskId: evidence.task.id,
        strategy: 'shout',
        status: evidence.agentResult?.output === 'HELLO' ? 'pass' : 'fail',
        score: evidence.agentResult?.output === 'HELLO' ? 1 : 0,
      }),
    })
    const loop = candidateLoop('HELLO')

    const run = await evalService.run({
      candidate: {
        plugin: loop.plugin,
        name: 'custom-candidate',
      },
      tasks: [task('t1', 'hello')],
      strategyNames: ['shout'],
    })

    expect(run.verdicts[0]!.strategy).toBe('shout')
    expect(run.verdicts[0]!.status).toBe('pass')
  })
})

describe('EvalRunner lifecycle', () => {
  it('emits eval lifecycle events and produces a run summary', async () => {
    const dir = await tempDir('tnega-eval-lifecycle-')
    const root = await setupRoot(dir)
    const events: string[] = []
    root.on('eval/start', () => events.push('start'))
    root.on('eval/task-start', () => events.push('task-start'))
    root.on('eval/task-end', () => events.push('task-end'))
    root.on('eval/verdict', () => events.push('verdict'))
    root.on('eval/run-end', () => events.push('run-end'))

    const loop = candidateLoop('ok')
    const run = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'lifecycle' },
      tasks: [task('t1', 'hi')],
    })

    expect(events).toEqual(['start', 'task-start', 'task-end', 'verdict', 'run-end'])
    expect(run.summary.total).toBe(1)
    expect(run.summary.passed).toBe(1)
    expect(run.summary.score).toBe(1)
    expect(run.taskIds).toEqual(['t1'])
    expect(run.candidate.name).toBe('lifecycle')
  })

  it('keeps the root runtime clean after an isolated candidate run', async () => {
    const dir = await tempDir('tnega-eval-isolate-')
    const root = await setupRoot(dir)
    root.provide('rootMarker', 'root-value')
    const seen: string[] = []
    root.on('candidate-event', () => seen.push('root-listener'))

    await service(root).run({
      candidate: {
        plugin: (ctx: Context) => {
          ctx.provide('candidateMarker', 'candidate-value')
          ctx.on('candidate-event', () => seen.push('candidate-listener'))
        },
        name: 'isolated',
      },
      tasks: [task('t1', 'hi')],
    })

    expect(root.get('candidateMarker')).toBeUndefined()
    expect(root.get('rootMarker')).toBe('root-value')
    root.emit('candidate-event')
    expect(seen).toEqual(['root-listener'])
  })

  it('unloads per-task plugins after each task', async () => {
    const dir = await tempDir('tnega-eval-task-unload-')
    const root = await setupRoot(dir)
    const loop = candidateLoop('ok')

    await service(root).run({
      candidate: { plugin: loop.plugin, name: 'unload' },
      tasks: [task('a', 'a'), task('b', 'b')],
    })

    expect(root.get('session')).toBeDefined()
    expect(root.get('tools')).toBeDefined()
  })

  it('collects error evidence and still produces verdicts', async () => {
    const dir = await tempDir('tnega-eval-error-')
    const root = await setupRoot(dir)
    const run = await service(root).run({
      candidate: {
        plugin: (ctx: Context) => {
          ctx.provide('agentLoop', async () => {
            throw new Error('agent crashed')
          })
        },
        name: 'broken',
      },
      tasks: [task('t1', 'hi')],
    })

    expect(run.aborted).toBe(false)
    expect(run.verdicts[0]!.status).toBe('fail')
    expect(run.verdicts[0]!.reason).toMatch(/empty output/)
  })
})

describe('EvalRunner budget and abort', () => {
  it('aborts before further tasks when the turn budget is exceeded', async () => {
    const dir = await tempDir('tnega-eval-budget-')
    const root = await setupRoot(dir)
    const loop = candidateLoop('ok')
    const run = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'budget' },
      tasks: [task('a', 'a'), task('b', 'b')],
      budget: { maxTurns: 0 },
    })

    expect(run.aborted).toBe(true)
    expect(run.abortedReason).toMatch(/budget/)
    expect(run.verdicts.length).toBeLessThan(2)
  })

  it('aborts a slow task via task time budget', async () => {
    const dir = await tempDir('tnega-eval-timeout-')
    const root = await setupRoot(dir)
    const abortEvents: string[] = []
    root.on('eval/abort', () => abortEvents.push('abort'))
    const run = await service(root).run({
      candidate: {
        plugin: (ctx: Context) => {
          ctx.provide('agentLoop', async () => {
            await new Promise(resolve => setTimeout(resolve, 120))
            return {
              input: {},
              output: 'late',
              finishReason: 'stop',
              steps: [],
              messages: [],
            }
          })
        },
        name: 'slow',
      },
      tasks: [task('t1', 'go', { budget: { maxTimeMs: 20 } })],
    })

    expect(run.verdicts).toHaveLength(1)
    expect(run.verdicts[0]!.status).toBe('fail')
    expect(abortEvents.length).toBeGreaterThan(0)
  })

  it('tracks token and cost usage', async () => {
    const dir = await tempDir('tnega-eval-usage-')
    const root = await setupRoot(dir)
    const loop = candidateLoop('hello world')
    const run = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'usage' },
      tasks: [task('t1', 'hi')],
    })

    expect(run.summary.budget.turns).toBe(0)
    expect(run.summary.budget.tokens).toBeGreaterThan(0)
    expect(run.summary.budget.cost).toBe(0)
  })
})

describe('EvalRunner cache and persistence', () => {
  it('reuses cached evidence on a second run', async () => {
    const dir = await tempDir('tnega-eval-cache-')
    const root = await setupRoot(dir)
    const loop = candidateLoop('ok')
    const first = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'cached', version: '1' },
      tasks: [task('t1', 'hi')],
      cache: true,
    })

    const second = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'cached', version: '1' },
      tasks: [task('t1', 'hi')],
      cache: true,
    })

    expect(loop.calls).toHaveLength(1)
    expect(first.cacheHits).toBe(0)
    expect(second.cacheHits).toBe(1)
    expect(second.verdicts[0]!.status).toBe(first.verdicts[0]!.status)
  })

  it('invalidates cache when the task input changes', async () => {
    const dir = await tempDir('tnega-eval-cache-invalid-')
    const root = await setupRoot(dir)
    const loop = candidateLoop('ok')
    const first = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'cached' },
      tasks: [task('t1', 'first')],
      cache: true,
    })
    const second = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'cached' },
      tasks: [task('t1', 'second')],
      cache: true,
    })

    expect(first.cacheHits).toBe(0)
    expect(second.cacheHits).toBe(0)
    expect(loop.calls).toHaveLength(2)
  })

  it('persists and reloads a run from the output directory', async () => {
    const dir = await tempDir('tnega-eval-persist-')
    const root = await setupRoot(dir)
    const loop = candidateLoop('persisted')
    const run = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'persist' },
      tasks: [task('t1', 'hi')],
    })

    const loaded = await service(root).loadRun(run.id)
    expect(loaded.id).toBe(run.id)
    expect(loaded.verdicts).toEqual(run.verdicts)
  })
})

describe('Eval compare', () => {
  async function makeRun(outputDir: string, output: string): Promise<EvalRun> {
    const root = await setupRoot(outputDir)
    const loop = candidateLoop(output)
    return service(root).run({
      candidate: { plugin: loop.plugin, name: 'compare' },
      tasks: [task('t1', 'hi', { assertion: { expect: 'good' } })],
    })
  }

  it('reports delta, regressions and improvements', async () => {
    const dir = await tempDir('tnega-eval-compare-')
    const base = await makeRun(dir, 'bad')
    const head = await makeRun(dir, 'good')
    const root = await setupRoot(dir)
    const result = await service(root).compare(base.id, head.id)

    expect(result.summary.baseScore).toBeLessThan(result.summary.headScore)
    expect(result.summary.improvements).toContain('t1')
    expect(result.summary.regressions).toEqual([])
    expect(result.taskResults[0]!.delta).toBeGreaterThan(0)
  })

  it('flags a regression when the head run scores lower', async () => {
    const dir = await tempDir('tnega-eval-regression-')
    const base = await makeRun(dir, 'good')
    const head = await makeRun(dir, 'bad')
    const root = await setupRoot(dir)
    const result = await service(root).compare(base.id, head.id)

    expect(result.summary.regressions).toContain('t1')
    expect(result.summary.delta).toBeLessThan(0)
  })
})

describe('built-in strategies', () => {
  it('assert matches exact output and list assertions', async () => {
    const dir = await tempDir('tnega-eval-assert-')
    const root = await setupRoot(dir)
    const loop = candidateLoop('the quick brown fox')
    const run = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'assert' },
      tasks: [
        task('exact', 'hi', { assertion: { expect: 'the quick brown fox' } }),
        task('list', 'hi', { assertion: { expect: ['quick', 'fox'] } }),
      ],
    })

    expect(run.verdicts.map(v => v.status)).toEqual(['pass', 'pass'])
  })

  it('assert fails on missing substrings', async () => {
    const dir = await tempDir('tnega-eval-assert-fail-')
    const root = await setupRoot(dir)
    const loop = candidateLoop('only words')
    const run = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'assert' },
      tasks: [task('t1', 'hi', { assertion: { expect: ['only', 'missing'] } })],
    })

    expect(run.verdicts[0]!.status).toBe('fail')
    expect(run.verdicts[0]!.reason).toContain('missing')
  })

  it('assert supports file assertions via artifacts', async () => {
    const dir = await tempDir('tnega-eval-files-')
    const root = await setupRoot(dir)
    const loop = candidateLoop('file output')
    const run = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'files' },
      tasks: [task('t1', 'hi', {
        assertion: { files: ['report.txt'] },
        artifacts: { 'report.txt': 'data' },
      })],
    })

    expect(run.verdicts[0]!.status).toBe('pass')
  })

  it('llm-judge records a deterministic score and replays it', async () => {
    const dir = await tempDir('tnega-eval-judge-')
    let judgeCalls = 0
    const judgeRoot = await setupRoot(dir, {
      llmJudge: (task, evidence) => {
        judgeCalls += 1
        void task
        return evidence.agentResult?.output === 'great' ? 0.9 : 0.1
      },
    })
    const loop = candidateLoop('great')
    const first = await service(judgeRoot).run({
      candidate: { plugin: loop.plugin, name: 'judge', model: { model: 'fake' } },
      tasks: [task('t1', 'hi')],
      strategyNames: ['llm-judge'],
      cache: true,
    })
    const second = await service(judgeRoot).run({
      candidate: { plugin: loop.plugin, name: 'judge', model: { model: 'fake' } },
      tasks: [task('t1', 'hi')],
      strategyNames: ['llm-judge'],
      cache: true,
    })

    expect(judgeCalls).toBe(1)
    expect(first.verdicts[0]!.score).toBe(0.9)
    expect(second.verdicts[0]!.score).toBe(0.9)
    expect(second.verdicts[0]!.meta).toMatchObject({ replayed: true })
  })

  it('regression skips without baseline and blocks degradation with baseline', async () => {
    const dir = await tempDir('tnega-eval-regression-strategy-')
    const root = await setupRoot(dir)
    const base = await service(root).run({
      candidate: { plugin: candidateLoop('good').plugin, name: 'base' },
      tasks: [task('t1', 'hi', { assertion: { expect: 'good' } })],
      strategyNames: ['assert'],
    })

    const headRoot = await setupRoot(dir)
    const head = await service(headRoot).run({
      candidate: { plugin: candidateLoop('bad').plugin, name: 'head' },
      tasks: [task('t1', 'hi', { assertion: { expect: 'good' } })],
      strategyNames: ['regression'],
      baselineRunId: base.id,
    })

    expect(head.verdicts[0]!.strategy).toBe('regression')
    expect(head.verdicts[0]!.status).toBe('fail')
    expect(head.verdicts[0]!.meta).toMatchObject({ degradation: 1 })

    const skipRoot = await setupRoot(dir)
    const skip = await service(skipRoot).run({
      candidate: { plugin: candidateLoop('good').plugin, name: 'skip' },
      tasks: [task('t1', 'hi')],
      strategyNames: ['regression'],
    })
    expect(skip.verdicts[0]!.status).toBe('skip')
  })

  it('gate requires mandatory strategies to pass', async () => {
    const dir = await tempDir('tnega-eval-gate-')
    const root = await setupRoot(dir, { gate: { required: ['safety'] } })
    let safetyPass = false
    service(root).register({
      name: 'safety',
      evaluate: (_ctx, task) => ({
        taskId: task.id,
        strategy: 'safety',
        status: safetyPass ? 'pass' as const : 'fail' as const,
        score: safetyPass ? 1 : 0,
      }),
    })
    const loop = candidateLoop('output')
    const failing = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'gate' },
      tasks: [task('t1', 'hi')],
      strategyNames: ['gate'],
    })
    expect(failing.verdicts[0]!.status).toBe('fail')
    expect(failing.verdicts[0]!.reason).toContain('required')

    safetyPass = true
    const passing = await service(root).run({
      candidate: { plugin: loop.plugin, name: 'gate' },
      tasks: [task('t1', 'hi')],
      strategyNames: ['gate'],
    })
    expect(passing.verdicts[0]!.status).toBe('pass')
  })
})
