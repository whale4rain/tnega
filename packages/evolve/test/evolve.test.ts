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
  type EvalPluginConfig,
  type EvalService,
  type Task,
} from '@tnega/eval'

import {
  evolvePlugin,
  type Candidate,
  type CandidateMutation,
  type Diagnosis,
  type EvolveStepResult,
  type EvolvePluginConfig,
  type EvolveService,
  type ProposeRule,
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
  dir: string,
  evalConfig: Partial<EvalPluginConfig> = {},
  evolveConfig: Partial<EvolvePluginConfig> = {},
): Promise<Context> {
  const root = new Context()
  await root.plugin(session, { file: join(dir, 'root-session.jsonl') })
  await root.plugin(tools)
  await root.plugin(agent)
  await root.plugin(evalPlugin, { outputDir: dir, ...evalConfig })
  await root.plugin(evolvePlugin, {
    outputDir: dir,
    logFile: join(dir, 'experiments.json'),
    ...evolveConfig,
  })
  return root
}

function service(root: Context): EvolveService {
  return dynamic(root).evolve as EvolveService
}

function evalService(root: Context): EvalService {
  return dynamic(root).eval as EvalService
}

function expectStep(result: EvolveStepResult): Exclude<EvolveStepResult, { kind: 'no-candidate' }> {
  expect(result.kind).not.toBe('no-candidate')
  return result as Exclude<EvolveStepResult, { kind: 'no-candidate' }>
}

function task(id: string, inputText: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    inputText,
    ...extra,
  }
}

function loopCandidate(
  name: string,
  output: string,
  options: {
    leak?: boolean
    throws?: boolean
    mutation?: CandidateMutation
    rationale?: string
  } = {},
): Candidate {
  const candidate: Candidate = {
    name,
    plugin: (ctx: Context) => {
      if (options.leak) ctx.provide('leakedCandidate', name)
      ctx.provide('agentLoop', async (input?: { text?: string }) => {
        if (options.throws) throw new Error('candidate crashed')
        return {
          input: input ?? {},
          output,
          finishReason: 'stop',
          steps: [],
          messages: [],
        }
      })
    },
  }
  if (options.mutation) candidate.mutation = options.mutation
  if (options.rationale) candidate.rationale = options.rationale
  return candidate
}

function registerScoreStrategy(root: Context): void {
  evalService(root).register({
    name: 'score',
    evaluate: (_ctx, task, evidence) => {
      const score = Number(evidence.agentResult?.output ?? 0) / 10
      return {
        taskId: task.id,
        strategy: 'score',
        status: score >= 0.5 ? 'pass' as const : 'fail' as const,
        score,
      }
    },
  })
}

describe('M4.1 candidate proposal and experiment log', () => {
  it('propose diagnoses the baseline and generates candidates with mutation and rationale', async () => {
    const dir = await tempDir('tnega-evolve-propose-')
    let seen: Diagnosis | undefined
    const rules: ProposeRule[] = [{
      id: 'repair',
      apply(context) {
        seen = context.diagnosis
        return loopCandidate('fix', 'target', {
          mutation: {
            type: 'output-patch',
            description: 'replace failing output',
            patch: { output: 'target' },
          },
          rationale: `repair ${context.diagnosis.failingTasks.length} tasks`,
        })
      },
    }]
    const root = await setupRoot(dir, {}, {
      rules,
      tasks: [task('t1', 'hello', { assertion: { expect: 'target' } })],
    })
    const evolve = service(root)

    const prime = expectStep(await evolve.step({
      establishBaseline: true,
      candidate: loopCandidate('base', 'wrong'),
    }))
    expect(prime.kind).toBe('established')

    const candidates = await evolve.propose()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.name).toBe('fix')
    expect(candidates[0]!.mutation).toMatchObject({
      type: 'output-patch',
      patch: { output: 'target' },
    })
    expect(candidates[0]!.rationale).toMatch(/repair 1 tasks/)
    expect(seen?.failingTasks).toContain('t1')
  })

  it('persists the experiment tree and supports fork and replay', async () => {
    const dir = await tempDir('tnega-evolve-log-')
    const root = await setupRoot(dir, {}, {
      tasks: [task('t1', 'hello', { assertion: { expect: 'target' } })],
    })
    const evolve = service(root)

    const prime = expectStep(await evolve.step({
      establishBaseline: true,
      candidate: loopCandidate('base', 'wrong'),
    }))
    expect(prime.kind).toBe('established')
    const child = await evolve.evaluate(loopCandidate('child', 'target'))
    const decided = await evolve.decide(child.id)
    expect(decided.status).toBe('accepted')

    const loaded = await evolve.loadLog(join(dir, 'experiments.json'))
    expect(loaded.size).toBe(2)
    expect(loaded.baselineId).toBe(child.id)
    expect(loaded.children(prime.node.id).map(node => node.id)).toEqual([child.id])

    const fork = await loaded.fork({ file: join(dir, 'fork.json') })
    expect(fork.baselineId).toBe(child.id)
    expect(fork.nodes()).toHaveLength(2)

    const replay = await loaded.replay(child.id)
    expect(replay.history).toEqual([prime.node.id, child.id])
    expect(replay.baseline?.id).toBe(prime.node.id)
    expect(replay.diagnosis.score).toBe(1)
  })
})

describe('M4.2 selection policy', () => {
  it('accepts a paired improvement and persists it as the new baseline', async () => {
    const dir = await tempDir('tnega-evolve-accept-')
    const root = await setupRoot(dir, {}, {
      policy: {
        minScore: 0.1,
        minDelta: 0.5,
        minPairs: 1,
        requireImprovement: true,
      },
      tasks: [task('t1', 'hello')],
      strategyNames: ['score'],
    })
    registerScoreStrategy(root)
    const evolve = service(root)

    const prime = expectStep(await evolve.step({
      establishBaseline: true,
      candidate: loopCandidate('base', '2'),
    }))
    expect(prime.kind).toBe('established')

    const result = expectStep(await evolve.step({
      candidate: loopCandidate('candidate', '9'),
    }))
    expect(result.kind).toBe('accepted')
    expect(result.node.status).toBe('accepted')
    expect(result.node.decision).toMatchObject({
      delta: 0.7,
      regressions: [],
      improvements: ['t1'],
    })
    const baseline = await evolve.baseline()
    expect(baseline?.id).toBe(result.node.id)
    expect(await evolve.history()).toHaveLength(2)
  })

  it('rejects a regression and keeps the old baseline', async () => {
    const dir = await tempDir('tnega-evolve-reject-')
    const root = await setupRoot(dir, {}, {
      policy: {
        minScore: 0.1,
        maxDegradation: 0,
      },
      tasks: [task('t1', 'hello')],
      strategyNames: ['score'],
    })
    registerScoreStrategy(root)
    const evolve = service(root)

    const prime = expectStep(await evolve.step({
      establishBaseline: true,
      candidate: loopCandidate('base', '9'),
    }))
    const result = expectStep(await evolve.step({
      candidate: loopCandidate('candidate', '1'),
    }))

    expect(result.kind).toBe('rejected')
    expect(result.node.decision?.delta).toBe(-0.8)
    expect(result.node.decision?.regressions).toContain('t1')
    const baseline = await evolve.baseline()
    expect(baseline?.id).toBe(prime.node.id)
  })

  it('allows a bounded regression when maxDegradation permits it', async () => {
    const dir = await tempDir('tnega-evolve-bound-')
    const root = await setupRoot(dir, {}, {
      policy: {
        minScore: 0.1,
        maxDegradation: 0.5,
      },
      tasks: [task('t1', 'hello')],
      strategyNames: ['score'],
    })
    registerScoreStrategy(root)
    const evolve = service(root)
    await evolve.step({ establishBaseline: true, candidate: loopCandidate('base', '9') })

    const result = expectStep(await evolve.step({ candidate: loopCandidate('candidate', '5') }))
    expect(result.kind).toBe('accepted')
    expect(result.node.decision?.delta).toBe(-0.4)
  })

  it('blocks a candidate that fails a required safety strategy', async () => {
    const dir = await tempDir('tnega-evolve-safety-')
    let safetyPass = true
    const root = await setupRoot(dir, {}, {
      policy: { safetyStrategies: ['safety'] },
      tasks: [task('t1', 'hello', { assertion: { expect: 'ok' } })],
      strategyNames: ['assert', 'safety'],
    })
    evalService(root).register({
      name: 'safety',
      evaluate: (_ctx, task) => ({
        taskId: task.id,
        strategy: 'safety',
        status: safetyPass ? 'pass' as const : 'fail' as const,
        score: safetyPass ? 1 : 0,
      }),
    })
    const evolve = service(root)
    const prime = expectStep(await evolve.step({
      establishBaseline: true,
      candidate: loopCandidate('base', 'ok'),
    }))
    expect(prime.kind).toBe('established')

    safetyPass = false
    const result = expectStep(await evolve.step({
      candidate: loopCandidate('candidate', 'ok'),
    }))
    expect(result.kind).toBe('rejected')
    expect(result.node.decision?.checks.some(check => check.name === 'safety:safety' && !check.ok)).toBe(true)
  })

  it('rejects a run that misses the significance rule', async () => {
    const dir = await tempDir('tnega-evolve-significance-')
    const root = await setupRoot(dir, {}, {
      policy: {
        minScore: 0.1,
        minDelta: 0.5,
        minPairs: 2,
      },
      tasks: [task('t1', 'hello')],
      strategyNames: ['score'],
    })
    registerScoreStrategy(root)
    const evolve = service(root)
    await evolve.step({ establishBaseline: true, candidate: loopCandidate('base', '2') })

    const result = expectStep(await evolve.step({ candidate: loopCandidate('candidate', '9') }))
    expect(result.kind).toBe('rejected')
    expect(result.node.decision?.checks.some(check => check.name === 'min-pairs' && !check.ok)).toBe(true)
  })

  it('aborts the loop when the eval budget is exhausted', async () => {
    const dir = await tempDir('tnega-evolve-budget-')
    const root = await setupRoot(dir, {}, {
      tasks: [task('t1', 'hello')],
    })
    const evolve = service(root)
    const prime = expectStep(await evolve.step({
      establishBaseline: true,
      candidate: loopCandidate('base', 'ok'),
    }))

    const result = expectStep(await evolve.step({
      candidate: loopCandidate('candidate', 'ok'),
      run: { budget: { maxTurns: 0 } },
    }))
    expect(result.kind).toBe('aborted')
    expect(result.node.run.aborted).toBe(true)
    expect(result.node.decision?.status).toBe('aborted')
    const baseline = await evolve.baseline()
    expect(baseline?.id).toBe(prime.node.id)
  })

  it('pauses at approval and resumes accept or reject', async () => {
    const dir = await tempDir('tnega-evolve-approval-')
    const events: string[] = []
    const root = await setupRoot(dir, {}, {
      policy: { requiresApproval: true },
      tasks: [task('t1', 'hello', { assertion: { expect: 'ok' } })],
    })
    root.on('eval/run-end', () => events.push('run-end'))
    root.on('evolve/approval-request', () => events.push('approval-request'))
    const evolve = service(root)

    const pending = expectStep(await evolve.step({
      establishBaseline: true,
      candidate: loopCandidate('base', 'ok'),
    }))
    expect(pending.kind).toBe('approval-pending')
    expect(pending.node.decision?.requiresApproval).toBe(true)
    expect(events).toEqual(['run-end', 'approval-request'])

    const accepted = await evolve.approve(pending.node.id, true)
    expect(accepted.status).toBe('accepted')
    expect((await evolve.baseline())?.id).toBe(accepted.id)

    const rejectedPending = expectStep(await evolve.step({
      candidate: loopCandidate('candidate', 'wrong'),
    }))
    expect(rejectedPending.kind).toBe('approval-pending')
    const rejected = await evolve.approve(rejectedPending.node.id, false)
    expect(rejected.status).toBe('rejected')
    expect(rejected.decision?.reason).toBe('rejected by approval')
    expect((await evolve.baseline())?.id).toBe(accepted.id)
  })
})

describe('M4.3 deterministic evolution loop', () => {
  it('evolves through rejected candidates until a better one is accepted', async () => {
    const dir = await tempDir('tnega-evolve-demo-')
    const outputs = ['3', '9']
    let calls = 0
    const root = await setupRoot(dir, {}, {
      policy: {
        minScore: 0.1,
        minDelta: 0.5,
        requireImprovement: true,
      },
      tasks: [task('t1', 'hello')],
      strategyNames: ['score'],
      rules: [{
        id: 'sequence',
        apply(context) {
          const output = outputs[Math.min(calls, outputs.length - 1)]!
          calls += 1
          return loopCandidate(`round-${context.iteration}`, output, {
            leak: true,
            mutation: { type: 'output', description: `try ${output}` },
            rationale: `score ${context.diagnosis.score.toFixed(2)}`,
          })
        },
      }],
    })
    registerScoreStrategy(root)
    root.provide('rootMarker', 'root-value')
    root.on('evolve-root-event', () => {})

    const evolve = service(root)
    const prime = expectStep(await evolve.step({
      establishBaseline: true,
      candidate: loopCandidate('base', '2'),
    }))
    expect(prime.kind).toBe('established')

    const result = expectStep(await evolve.evolve({ maxIterations: 5 }))
    expect(result.kind).toBe('accepted')
    expect(result.node.candidate.name).toBe('round-1')
    expect(result.node.run.summary.score).toBe(0.9)

    expect(root.get('rootMarker')).toBe('root-value')
    expect(root.get('leakedCandidate')).toBeUndefined()
  })

  it('keeps the root runtime clean when a candidate loop throws', async () => {
    const dir = await tempDir('tnega-evolve-isolation-')
    const root = await setupRoot(dir, {}, {
      policy: { minScore: 0.1 },
      tasks: [task('t1', 'hello')],
    })
    const evolve = service(root)
    await evolve.step({
      establishBaseline: true,
      candidate: loopCandidate('base', 'ok'),
    })
    root.provide('rootMarker', 'root-value')

    const result = expectStep(await evolve.step({
      candidate: loopCandidate('broken', 'ignored', { leak: true, throws: true }),
    }))
    expect(result.kind).toBe('rejected')
    expect(root.get('rootMarker')).toBe('root-value')
    expect(root.get('leakedCandidate')).toBeUndefined()
  })
})
