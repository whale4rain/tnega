import {
  type EvalStrategy,
  type EvalStrategyDefinition,
  type Evidence,
  type Task,
  type Verdict,
} from './types.js'

export interface AssertStrategyOptions {
  /** Compare exact output when no task assertion is present. */
  expect?: string | string[]
  /** Treat a failing task as error instead of fail. */
  strictFiles?: boolean
}

export interface JudgeStrategyOptions {
  judge?: (task: Task, evidence: Evidence) => number | Promise<number>
  /** Threshold above which the verdict passes (default 0.5). */
  passThreshold?: number
}

export interface RegressionStrategyOptions {
  maxDegradation?: number
  requireBaseline?: boolean
}

export interface AllStrategyOptions {
  strategies?: string[]
}

export interface WeightedStrategyOptions {
  strategies?: Array<{ name: string; weight: number }>
  passThreshold?: number
}

export interface GateStrategyOptions {
  required?: string[]
  thresholds?: Record<string, number>
  minScore?: number
}

function errorVerdict(taskId: string, strategy: string, message: string): Verdict {
  return {
    taskId,
    strategy,
    status: 'error',
    score: 0,
    reason: message,
  }
}

function cloneVerdict(verdict: Verdict): Verdict {
  return {
    ...verdict,
    ...(verdict.output !== undefined ? { output: structuredClone(verdict.output) } : {}),
    ...(verdict.meta !== undefined ? { meta: structuredClone(verdict.meta) } : {}),
  }
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output) ?? String(output)
  } catch {
    return String(output)
  }
}

export function assertStrategy(options: AssertStrategyOptions = {}): EvalStrategy {
  return {
    name: 'assert',
    async evaluate(_ctx, task, evidence) {
      const assertion: Task['assertion'] = {
        ...(task.assertion ?? {}),
        ...(options.expect !== undefined ? { expect: options.expect } : {}),
      }
      const output = stringifyOutput(evidence.agentResult?.output ?? evidence.artifacts.output ?? '')

      if (assertion.check) {
        const ok = await assertion.check(evidence, task)
        return {
          taskId: task.id,
          strategy: 'assert',
          status: ok ? 'pass' : 'fail',
          score: ok ? 1 : 0,
          reason: ok ? 'predicate passed' : 'predicate failed',
          output,
        }
      }

      if (assertion.expect !== undefined) {
        const expected = Array.isArray(assertion.expect) ? assertion.expect : [assertion.expect]
        const missing = expected.filter(item => !output.includes(item))
        const ok = missing.length === 0
        return {
          taskId: task.id,
          strategy: 'assert',
          status: ok ? 'pass' : 'fail',
          score: ok ? 1 : 0,
          reason: ok ? 'output matched' : `missing: ${missing.join(', ')}`,
          output,
        }
      }

      if (assertion.files) {
        const ok = typeof assertion.files === 'function'
          ? await assertion.files(evidence)
          : assertion.files.every(file => evidence.artifacts[file] !== undefined)
        return {
          taskId: task.id,
          strategy: 'assert',
          status: ok ? 'pass' : 'fail',
          score: ok ? 1 : 0,
          reason: ok ? 'files present' : 'files missing',
          output,
        }
      }

      return {
        taskId: task.id,
        strategy: 'assert',
        status: output ? 'pass' : 'fail',
        score: output ? 1 : 0,
        reason: output ? 'non-empty output' : 'empty output',
        output,
      }
    },
  }
}

const judgeScores = new Map<string, number>()

export function recordJudgeOutput(key: string, score: number): void {
  judgeScores.set(key, score)
}

export function recordedJudgeOutput(key: string): number | undefined {
  return judgeScores.get(key)
}

export function judgeStrategy(options: JudgeStrategyOptions = {}): EvalStrategy {
  return {
    name: 'llm-judge',
    async evaluate(ctx, task, evidence) {
      const replayKey = [
        ctx.run.candidate.name,
        ctx.run.candidate.version ?? '',
        task.id,
        'llm-judge',
        String(evidence.artifacts.modelConfigHash ?? ''),
      ].join(':')
      const recorded = recordedJudgeOutput(replayKey)
      if (recorded !== undefined) {
        const threshold = options.passThreshold ?? 0.5
        return {
          taskId: task.id,
          strategy: 'llm-judge',
          status: recorded >= threshold ? 'pass' : 'fail',
          score: recorded,
          reason: 'replayed recorded judge score',
          meta: { replayed: true, hash: evidence.artifacts.modelConfigHash ?? '' },
        }
      }

      if (options.judge) {
        const score = Math.max(0, Math.min(1, Number(await options.judge(task, evidence)) || 0))
        const threshold = options.passThreshold ?? 0.5
        recordJudgeOutput(replayKey, score)
        return {
          taskId: task.id,
          strategy: 'llm-judge',
          status: score >= threshold ? 'pass' : 'fail',
          score,
          reason: `judge scored ${score.toFixed(3)}`,
          meta: { replayed: false },
        }
      }

      return errorVerdict(
        task.id,
        'llm-judge',
        'no judge function and no recorded score available',
      )
    },
  }
}

export function regressionStrategy(options: RegressionStrategyOptions = {}): EvalStrategy {
  return {
    name: 'regression',
    async evaluate(ctx, task, evidence) {
      if (!ctx.baseline) {
        if (options.requireBaseline) {
          return errorVerdict(task.id, 'regression', 'baseline run required')
        }
        return {
          taskId: task.id,
          strategy: 'regression',
          status: 'skip',
          score: 0,
          reason: 'no baseline',
          meta: { skipped: true },
        }
      }

      const base = ctx.baseline.verdicts.find(verdict => verdict.taskId === task.id)
      const headScore = verdictScore(ctx, task, evidence)
      if (!base) {
        return {
          taskId: task.id,
          strategy: 'regression',
          status: 'skip',
          score: headScore,
          reason: 'task absent from baseline',
          meta: { skipped: true, headScore },
        }
      }

      const delta = headScore - base.score
      const degradation = Math.max(0, base.score - headScore)
      const limit = options.maxDegradation ?? 0
      const ok = degradation <= limit
      return {
        taskId: task.id,
        strategy: 'regression',
        status: ok ? 'pass' : 'fail',
        score: headScore,
        reason: ok
          ? `head ${headScore.toFixed(3)} vs base ${base.score.toFixed(3)}`
          : `degraded by ${degradation.toFixed(3)}, limit ${limit.toFixed(3)}`,
        meta: {
          baseScore: base.score,
          headScore,
          delta,
          degradation,
          limit,
        },
      }
    },
  }
}

function verdictScore(ctx: import('./types.js').StrategyContext, task: Task, evidence: Evidence): number {
  const recorded = evidence.strategyOutputs['score']
  if (typeof recorded === 'number') return recorded
  const output = stringifyOutput(evidence.agentResult?.output ?? evidence.artifacts.output ?? '')
  if (task.assertion?.expect !== undefined) {
    const expected = Array.isArray(task.assertion.expect)
      ? task.assertion.expect
      : [task.assertion.expect]
    return expected.every(item => output.includes(item)) ? 1 : 0
  }
  if (output) return 1
  return ctx.baseline?.verdicts.find(verdict => verdict.taskId === task.id)?.score ?? 0
}

export function allStrategy(options: AllStrategyOptions = {}): EvalStrategy {
  return {
    name: 'all',
    async evaluate(ctx, task, evidence) {
      const names = options.strategies ?? ctx.ctx.get('evalStrategies') ?? []
      const strategies = (Array.isArray(names) ? names : []) as string[]
      const verdicts: Verdict[] = []
      for (const name of strategies) {
        const strategy = (ctx.ctx.get('eval') as { getStrategy(name: string): EvalStrategy | undefined })
          .getStrategy(name)
        if (!strategy) {
          verdicts.push(errorVerdict(task.id, 'all', `strategy not found: ${name}`))
          continue
        }
        verdicts.push(await strategy.evaluate(ctx, task, evidence))
      }
      const passed = verdicts.every(verdict => verdict.status === 'pass')
      return {
        taskId: task.id,
        strategy: 'all',
        status: passed ? 'pass' : 'fail',
        score: passed ? 1 : 0,
        reason: passed ? 'all sub-strategies passed' : 'one or more sub-strategies failed',
        meta: { verdicts: verdicts.map(cloneVerdict) },
      }
    },
  }
}

export function weightedStrategy(options: WeightedStrategyOptions = {}): EvalStrategy {
  return {
    name: 'weighted',
    async evaluate(ctx, task, evidence) {
      const items = options.strategies ?? []
      if (!items.length) {
        return errorVerdict(task.id, 'weighted', 'no weighted strategies configured')
      }
      const service = ctx.ctx.get('eval') as { getStrategy(name: string): EvalStrategy | undefined }
      let total = 0
      let weightSum = 0
      for (const item of items) {
        const strategy = service.getStrategy(item.name)
        if (!strategy) {
          return errorVerdict(task.id, 'weighted', `strategy not found: ${item.name}`)
        }
        const verdict = await strategy.evaluate(ctx, task, evidence)
        total += verdict.score * item.weight
        weightSum += item.weight
      }
      const score = weightSum ? total / weightSum : 0
      const threshold = options.passThreshold ?? 0.5
      return {
        taskId: task.id,
        strategy: 'weighted',
        status: score >= threshold ? 'pass' : 'fail',
        score,
        reason: `weighted score ${score.toFixed(3)}, threshold ${threshold.toFixed(3)}`,
      }
    },
  }
}

export function gateStrategy(options: GateStrategyOptions = {}): EvalStrategy {
  return {
    name: 'gate',
    async evaluate(ctx, task, evidence) {
      const service = ctx.ctx.get('eval') as { getStrategy(name: string): EvalStrategy | undefined }
      const required = options.required ?? []
      const verdicts: Verdict[] = []
      for (const name of required) {
        const strategy = service.getStrategy(name)
        if (!strategy) {
          verdicts.push(errorVerdict(task.id, 'gate', `required strategy not found: ${name}`))
          continue
        }
        verdicts.push(await strategy.evaluate(ctx, task, evidence))
      }
      const failed = verdicts.filter(verdict => verdict.status !== 'pass')
      const score = verdicts.length
        ? verdicts.reduce((sum, verdict) => sum + verdict.score, 0) / verdicts.length
        : 0
      const underThreshold = verdicts.some(verdict => {
        const threshold = options.thresholds?.[verdict.strategy]
        return threshold !== undefined && verdict.score < threshold
      })
      const minScoreOk = options.minScore === undefined || score >= options.minScore
      const ok = failed.length === 0 && !underThreshold && minScoreOk
      return {
        taskId: task.id,
        strategy: 'gate',
        status: ok ? 'pass' : 'fail',
        score,
        reason: ok
          ? 'gate passed'
          : failed.length
            ? `required verdicts failed: ${failed.map(v => v.strategy).join(', ')}`
            : 'gate threshold not met',
        meta: { verdicts: verdicts.map(cloneVerdict), score },
      }
    },
  }
}

export interface StrategyRegistry {
  register(definition: EvalStrategyDefinition): () => void
  unregister(name: string): boolean
  get(name: string): EvalStrategy | undefined
  has(name: string): boolean
  names(): string[]
}

export function createStrategyRegistry(initial: EvalStrategyDefinition[] = []): StrategyRegistry {
  const strategies = new Map<string, EvalStrategy>()
  for (const definition of initial) {
    const strategy: EvalStrategy = {
      name: definition.name,
      evaluate: definition.evaluate,
    }
    strategies.set(definition.name, strategy)
  }

  return {
    register(definition) {
      const strategy: EvalStrategy = {
        name: definition.name,
        evaluate: definition.evaluate,
      }
      if (strategies.has(definition.name)) {
        throw new Error(`strategy already registered: ${definition.name}`)
      }
      strategies.set(definition.name, strategy)
      return () => {
        if (strategies.get(definition.name) === strategy) {
          strategies.delete(definition.name)
        }
      }
    },
    unregister(name) {
      return strategies.delete(name)
    },
    get(name) {
      return strategies.get(name)
    },
    has(name) {
      return strategies.has(name)
    },
    names() {
      return [...strategies.keys()]
    },
  }
}

export function defaultStrategyDefinitions(): EvalStrategyDefinition[] {
  return [
    assertStrategy(),
    judgeStrategy(),
    regressionStrategy(),
    allStrategy(),
    weightedStrategy(),
    gateStrategy(),
  ]
}
