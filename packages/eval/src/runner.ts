import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@tnega/core'
import type { AgentInput, AgentLoop, AgentRunResult } from '@tnega/agent'
import type { SessionLog } from '@tnega/session'
import { session } from '@tnega/session'
import { tools } from '@tnega/tools'
import {
  type BudgetUsage,
  type Evidence,
  type EvalRun,
  type EvalRunOptions,
  type RunBudget,
  type Task,
  type Verdict,
} from './types.js'
import { clone, hashJson, loadJson, saveJson } from './utils.js'
import type { StrategyRegistry } from './strategies.js'

interface TaskRunState {
  task: Task
  scope: Context
  dispose(): Promise<void>
}

export class EvalRunner {
  constructor(
    private ctx: Context,
    private strategies: StrategyRegistry,
    private defaultBudget: RunBudget = {},
    private outputDir = '.tnega/runs',
  ) {}

  async run(options: EvalRunOptions): Promise<EvalRun> {
    const id = randomUUID()
    const runScope = this.ctx
      .isolate('eval')
      .isolate('agentLoop')
      .isolate('session')
      .isolate('tools')
    const candidateFiber = runScope.plugin(options.candidate.plugin, options.candidate.config)
    try {
      await candidateFiber
    } catch (error) {
      this._abort(runScope, id, `candidate failed to load: ${this._message(error)}`)
      throw error
    }

    const candidate = {
      name: options.candidate.name,
      ...(options.candidate.version ? { version: options.candidate.version } : {}),
      ...(options.candidate.config ? { config: options.candidate.config } : {}),
      ...(options.candidate.model ? { model: options.candidate.model } : {}),
    }
    const modelConfigHash = options.candidate.model
      ? hashJson(options.candidate.model)
      : undefined
    const budget: RunBudget = {
      ...this.defaultBudget,
      ...(options.budget ?? {}),
    }
    const startedAt = Date.now()
    const usage: BudgetUsage = {
      turns: 0,
      tokens: 0,
      cost: 0,
      timeMs: 0,
    }
    const controller = new AbortController()
    let aborted = false
    let abortedReason: string | undefined
    const run: EvalRun = {
      id,
      createdAt: startedAt,
      candidate,
      taskIds: options.tasks.map(task => task.id),
      verdicts: [],
      summary: {
        total: options.tasks.length,
        passed: 0,
        failed: 0,
        skipped: 0,
        errors: 0,
        score: 0,
        budget: usage,
      },
      cacheHits: 0,
      aborted,
      ...(modelConfigHash ? { modelConfigHash } : {}),
      ...(options.baselineRunId ? { baselineRunId: options.baselineRunId } : {}),
    }

    const baseline = options.baselineRunId
      ? await this._loadRun(join(this.outputDir, `${options.baselineRunId}.json`))
      : undefined

    this.ctx.emit('eval/start', {
      runId: id,
      candidate,
      taskIds: run.taskIds,
      budget,
    })

    for (const task of options.tasks) {
      if (controller.signal.aborted || this._exceeded(budget, usage)) {
        aborted = true
        abortedReason = 'budget exceeded'
        this._abort(runScope, id, abortedReason)
        break
      }

      const taskStartedAt = Date.now()
      const cacheKey = options.cache
        ? this._cacheKey(task, options.candidate, modelConfigHash)
        : undefined
      const cachedEvidence = cacheKey ? await this._loadCachedEvidence(cacheKey) : undefined

      let evidence: Evidence
      let fromCache = false
      if (cachedEvidence) {
        evidence = cachedEvidence
        fromCache = true
        run.cacheHits += 1
        this.ctx.emit('eval/task-start', {
          runId: id,
          task,
          scope: runScope,
        })
      } else {
      const state = await this._createTaskScope(runScope, task)
        try {
          this.ctx.emit('eval/task-start', {
            runId: id,
            task,
            scope: state.scope,
          })
          this._armTimeout(task, controller)
          evidence = await this._runTask(
            state.scope,
            task,
            options,
            run,
            controller,
            usage,
          )
        } finally {
          await state.dispose()
        }
        usage.timeMs = Date.now() - startedAt
        if (cacheKey) {
          await this._saveCachedEvidence(cacheKey, evidence)
        }
      }

      const durationMs = Date.now() - taskStartedAt
      this.ctx.emit('eval/task-end', {
        runId: id,
        task,
        evidence,
        durationMs,
        fromCache,
      })

      const strategyNames = task.strategies?.length
        ? task.strategies
        : options.strategyNames?.length
          ? options.strategyNames
          : ['assert']
      for (const name of strategyNames) {
        const strategy = this.strategies.get(name)
        const verdict = strategy
          ? await strategy.evaluate(
              {
                ctx: this.ctx,
                run,
                ...(baseline ? { baseline } : {}),
              },
              task,
              evidence,
            )
          : {
              taskId: task.id,
              strategy: name,
              status: 'error' as const,
              score: 0,
              reason: `strategy not found: ${name}`,
            }
        run.verdicts.push(verdict)
        this.ctx.emit('eval/verdict', {
          runId: id,
          taskId: task.id,
          verdict,
        })
      }

      if (this._exceeded(budget, usage)) {
        aborted = true
        abortedReason = 'budget exceeded'
        this._abort(runScope, id, abortedReason)
        break
      }
    }

    const summary = this._summarize(run.verdicts, usage)
    run.summary = summary
    run.aborted = aborted
    if (abortedReason) run.abortedReason = abortedReason

    await candidateFiber.dispose()
    this.ctx.emit('eval/run-end', { run: clone(run) })
    if (options.outputFile) {
      await saveJson(options.outputFile, run)
    } else {
      await saveJson(join(this.outputDir, `${id}.json`), run)
    }
    return run
  }

  private async _createTaskScope(runScope: Context, task: Task): Promise<TaskRunState> {
    const scope = runScope.isolate(`task:${task.id}`)
    const sessionFile = await this._sessionFile(task.id)
    const sessionFiber = await scope.plugin(session, { file: sessionFile })
    const toolsFiber = await scope.plugin(tools)
    return {
      task,
      scope,
      dispose: async () => {
        await toolsFiber.dispose()
        await sessionFiber.dispose()
      },
    }
  }

  private _armTimeout(task: Task, controller: AbortController): void {
    if (task.budget?.maxTimeMs === undefined) return
    const timer = setTimeout(() => {
      controller.abort()
    }, task.budget.maxTimeMs)
    timer.unref()
  }

  private async _runTask(
    scope: Context,
    task: Task,
    options: EvalRunOptions,
    run: EvalRun,
    controller: AbortController,
    usage: BudgetUsage,
  ): Promise<Evidence> {
    const input: AgentInput = {
      ...(task.inputText !== undefined ? { text: task.inputText } : {}),
      ...(task.messages?.length ? { messages: clone(task.messages) } : {}),
      ...(task.input && typeof task.input === 'object'
        ? { context: clone(task.input) }
        : {}),
    }
    let agentResult: AgentRunResult | undefined
    let error: unknown
    const loop = options.runCandidate
      ? (agentInput: AgentInput) => options.runCandidate!(scope, {
          ...task,
          input: agentInput,
        })
      : this._loop(scope) ?? (this.ctx.root.get('agentLoop') as AgentLoop | undefined)
    if (!loop) {
      throw new Error('no agentLoop available; provide a candidate agentLoop or runCandidate')
    }

    try {
      agentResult = await loop(input)
      usage.turns += agentResult.steps.length
      usage.tokens += this._tokens(agentResult)
      usage.cost += this._cost(agentResult)
      usage.timeMs = Date.now() - run.createdAt
      if (controller.signal.aborted) {
        error = new Error('aborted: task time budget exceeded')
        agentResult = undefined
        this.ctx.emit('eval/abort', {
          runId: run.id,
          taskId: task.id,
          reason: 'task time budget exceeded',
        })
      }
    } catch (caught) {
      error = caught
    }

    const session = scope.get('session') as SessionLog | undefined
    const messages = session
      ? await session.deriveMessages()
      : agentResult?.messages
        ? clone([...agentResult.messages])
        : []
    const artifacts: Record<string, unknown> = {
      ...clone(task.artifacts ?? {}),
      ...(run.modelConfigHash ? { modelConfigHash: run.modelConfigHash } : {}),
    }
    if (error) {
      artifacts.error = this._errorPayload(error)
    }

    return {
      task,
      ...(agentResult ? { agentResult: clone(agentResult) } : {}),
      messages: clone(messages),
      artifacts,
      strategyOutputs: {},
    }
  }

  private _loop(scope: Context): AgentLoop | undefined {
    return scope.get('agentLoop') as AgentLoop | undefined
  }

  private _cacheKey(
    task: Task,
    candidate: { name: string; version?: string; config?: Record<string, unknown> },
    modelConfigHash: string | undefined,
  ): string {
    return hashJson({
      task: {
        id: task.id,
        input: task.input,
        inputText: task.inputText,
        messages: task.messages,
      },
      candidate: {
        name: candidate.name,
        version: candidate.version,
        config: candidate.config,
      },
      model: modelConfigHash,
    })
  }

  private async _sessionFile(taskId: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `tnega-eval-${taskId}-`))
    return join(dir, 'session.jsonl')
  }

  private _tokens(result: AgentRunResult): number {
    let tokens = 0
    for (const message of result.messages) {
      tokens += Math.ceil(message.content.length / 4)
    }
    return tokens
  }

  private _cost(result: AgentRunResult): number {
    const meta = result.messages.at(-1)
    const record = meta as unknown as { cost?: unknown } | undefined
    if (record && typeof record.cost === 'number') {
      return record.cost
    }
    return 0
  }

  private _exceeded(budget: RunBudget, usage: BudgetUsage): boolean {
    if (budget.maxTimeMs !== undefined && usage.timeMs >= budget.maxTimeMs) return true
    if (budget.maxTurns !== undefined && usage.turns >= budget.maxTurns) return true
    if (budget.maxTokens !== undefined && usage.tokens >= budget.maxTokens) return true
    if (budget.maxCost !== undefined && usage.cost >= budget.maxCost) return true
    return false
  }

  private _summarize(verdicts: readonly Verdict[], usage: BudgetUsage) {
    let passed = 0
    let failed = 0
    let skipped = 0
    let errors = 0
    let scoreSum = 0
    for (const verdict of verdicts) {
      if (verdict.status === 'pass') passed += 1
      else if (verdict.status === 'fail') failed += 1
      else if (verdict.status === 'skip') skipped += 1
      else errors += 1
      scoreSum += verdict.score
    }
    return {
      total: verdicts.length,
      passed,
      failed,
      skipped,
      errors,
      score: verdicts.length ? scoreSum / verdicts.length : 0,
      budget: { ...usage },
    }
  }

  private _abort(scope: Context, runId: string, reason: string): void {
    this.ctx.emit('eval/abort', { runId, reason })
    void scope
  }

  private async _loadRun(file: string): Promise<EvalRun | undefined> {
    try {
      return await loadJson<EvalRun>(file)
    } catch {
      return undefined
    }
  }

  private async _loadCachedEvidence(cacheKey: string): Promise<Evidence | undefined> {
    try {
      return await loadJson<Evidence>(join(this.outputDir, `${cacheKey}.cache.json`))
    } catch {
      return undefined
    }
  }

  private async _saveCachedEvidence(cacheKey: string, evidence: Evidence): Promise<void> {
    await saveJson(join(this.outputDir, `${cacheKey}.cache.json`), evidence)
  }

  private _message(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
  }

  private _errorPayload(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
      return {
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      }
    }
    return { message: String(error) }
  }
}
