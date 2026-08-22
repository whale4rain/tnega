import type { Context } from '@tnega/core'
import {
  createStrategyRegistry,
  defaultStrategyDefinitions,
  gateStrategy,
  judgeStrategy,
  type StrategyRegistry,
} from './strategies.js'
import { EvalRunner } from './runner.js'
import {
  type CompareResult,
  type EvalPluginConfig,
  type EvalRun,
  type EvalRunOptions,
  type EvalStrategyDefinition,
  type Verdict,
} from './types.js'
import { loadJson, saveJson } from './utils.js'

export class EvalService {
  readonly strategies: StrategyRegistry

  constructor(
    private ctx: Context,
    private config: EvalPluginConfig = {},
  ) {
    this.strategies = createStrategyRegistry()
    for (const definition of defaultStrategyDefinitions()) {
      this.strategies.register(definition)
    }
    if (config.llmJudge) {
      this.strategies.unregister('llm-judge')
      this.strategies.register(judgeStrategy({ judge: config.llmJudge }))
    }
    if (config.gate) {
      this.strategies.unregister('gate')
      this.strategies.register(gateStrategy(config.gate))
    }
  }

  register(definition: EvalStrategyDefinition): () => void {
    return this.strategies.register(definition)
  }

  unregister(name: string): boolean {
    return this.strategies.unregister(name)
  }

  getStrategy(name: string) {
    return this.strategies.get(name)
  }

  listStrategies(): string[] {
    return this.strategies.names()
  }

  async run(options: EvalRunOptions): Promise<EvalRun> {
    const runner = new EvalRunner(
      this.ctx,
      this.strategies,
      this.config.defaultBudget,
      this.config.outputDir,
    )
    return runner.run(options)
  }

  async loadRun(input: string | EvalRun): Promise<EvalRun> {
    if (typeof input !== 'string') return input
    const candidates = [
      input,
      `${this.config.outputDir ?? '.tnega/runs'}/${input}.json`,
      `${this.config.outputDir ?? '.tnega/runs'}/${input}`,
    ]
    for (const file of candidates) {
      try {
        return await loadJson<EvalRun>(file)
      } catch {
        // try the next candidate path
      }
    }
    throw new Error(`eval run not found: ${input}`)
  }

  async saveRun(run: EvalRun, file?: string): Promise<string> {
    const target = file ?? `${this.config.outputDir ?? '.tnega/runs'}/${run.id}.json`
    await saveJson(target, run)
    return target
  }

  async compare(base: string | EvalRun, head: string | EvalRun): Promise<CompareResult> {
    const baseRun = await this.loadRun(base)
    const headRun = await this.loadRun(head)
    const taskIds = [...new Set([...baseRun.taskIds, ...headRun.taskIds])]
    const regressions: string[] = []
    const improvements: string[] = []
    let passed = 0
    let failed = 0

    const taskResults = taskIds.map((taskId) => {
      const baseVerdict = this._taskVerdict(baseRun, taskId)
      const headVerdict = this._taskVerdict(headRun, taskId)
      const baseScore = baseVerdict?.score ?? 0
      const headScore = headVerdict?.score ?? 0
      const delta = headScore - baseScore
      if (delta < 0) regressions.push(taskId)
      if (delta > 0) improvements.push(taskId)
      if (headVerdict?.status === 'pass') passed += 1
      else if (headVerdict) failed += 1
      return {
        taskId,
        base: baseVerdict,
        head: headVerdict,
        delta,
        changed: delta !== 0,
      }
    })

    return {
      base: baseRun,
      head: headRun,
      summary: {
        baseScore: this._score(baseRun),
        headScore: this._score(headRun),
        delta: this._score(headRun) - this._score(baseRun),
        passed,
        failed,
        regressions,
        improvements,
      },
      taskResults,
    }
  }

  private _taskVerdict(run: EvalRun, taskId: string): Verdict | undefined {
    const verdicts = run.verdicts.filter(verdict => verdict.taskId === taskId)
    return verdicts.at(-1)
  }

  private _score(run: EvalRun): number {
    if (!run.verdicts.length) return 0
    return run.verdicts.reduce((sum, verdict) => sum + verdict.score, 0) / run.verdicts.length
  }
}

export const evalPlugin = {
  name: 'eval',
  apply: (ctx: Context, config: EvalPluginConfig = {}) => {
    const service = new EvalService(ctx, config)
    ctx.provide('eval', service)
    return () => {}
  },
}
