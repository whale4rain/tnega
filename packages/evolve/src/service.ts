import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@tnega/core'
import type { EvalRunOptions, EvalService } from '@tnega/eval'
import {
  diagnose,
  emptyDiagnosis,
  proposeCandidates,
  proposalContext,
  toCandidatePreset,
  toCandidateSnapshot,
} from './diagnose.js'
import { ExperimentLog } from './log.js'
import { evaluateGate } from './select.js'
import type {
  ApprovalRequest,
  Candidate,
  EvolveOptions,
  EvolvePluginConfig,
  EvolveStepOptions,
  EvolveStepResult,
  ExperimentNode,
  ProposalContext,
  SelectionDecision,
} from './types.js'

export class EvolveService {
  private _log: ExperimentLog | undefined
  private _ready: Promise<ExperimentLog> | undefined

  constructor(
    private ctx: Context,
    private config: EvolvePluginConfig = {},
  ) {}

  async init(): Promise<ExperimentLog> {
    if (this._log) return this._log
    if (!this._ready) {
      this._ready = ExperimentLog.open(this._logFile()).then((log) => {
        this._log = log
        return log
      })
    }
    return this._ready
  }

  async propose(options: Partial<ProposalContext> = {}): Promise<Candidate[]> {
    const log = await this.init()
    const baseline = options.baseline ?? log.baseline?.run
    const history = options.history ?? log.nodes()
    const iteration = options.iteration ?? history.length
    const diagnosis = options.diagnosis ?? (baseline ? diagnose(baseline) : emptyDiagnosis())
    const rules = this.config.rules ?? []
    const context = proposalContext(baseline, history, rules, iteration, diagnosis)
    const candidates = await proposeCandidates(context, rules)
    this.ctx.emit('evolve/propose', {
      iteration,
      ...(baseline?.id ? { baselineRunId: baseline.id } : {}),
      candidates: candidates.map(toCandidateSnapshot),
    })
    return candidates
  }

  async evaluate(
    candidate: Candidate,
    options: Partial<EvalRunOptions> = {},
  ): Promise<ExperimentNode> {
    const log = await this.init()
    const evalService = this._eval()
    const parent = options.baselineRunId
      ? this._nodeByRunId(log, options.baselineRunId)
      : log.baseline
    const tasks = options.tasks ?? this.config.tasks
    if (!tasks?.length) {
      throw new Error('evolve requires at least one eval task')
    }

    const runOptions: EvalRunOptions = {
      candidate: toCandidatePreset(candidate),
      tasks,
      ...(options.strategyNames ?? this.config.strategyNames
        ? { strategyNames: options.strategyNames ?? this.config.strategyNames }
        : {}),
    }
    const budget = options.budget ?? this.config.budget
    if (budget) runOptions.budget = budget
    const cache = options.cache ?? this.config.cache
    if (cache !== undefined) runOptions.cache = cache
    if (parent) runOptions.baselineRunId = parent.run.id
    else if (options.baselineRunId) runOptions.baselineRunId = options.baselineRunId
    if (options.outputFile) runOptions.outputFile = options.outputFile
    if (options.runCandidate) runOptions.runCandidate = options.runCandidate

    const run = await evalService.run(runOptions)
    const node: ExperimentNode = {
      id: randomUUID(),
      ...(parent ? { parentId: parent.id } : {}),
      candidate: toCandidateSnapshot(candidate),
      run,
      status: 'pending',
      createdAt: Date.now(),
    }
    await log.add(node)
    this.ctx.emit('evolve/run', {
      nodeId: node.id,
      runId: run.id,
      candidate: node.candidate,
    })

    if (this.config.policy?.requiresApproval) {
      node.decision = {
        status: 'pending',
        reason: 'awaiting approval',
        checks: [],
        requiresApproval: true,
      }
      await log.update(node)
      const request: ApprovalRequest = {
        nodeId: node.id,
        candidate: node.candidate,
        run,
        ...(parent ? { baseline: parent.run } : {}),
      }
      this.ctx.emit('evolve/approval-request', { node, request })
    }

    return node
  }

  async decide(nodeId: string, approved = true): Promise<ExperimentNode> {
    const log = await this.init()
    const node = log.get(nodeId)
    if (!node) throw new Error(`experiment node not found: ${nodeId}`)
    if (node.status !== 'pending') {
      throw new Error(`experiment node already decided: ${node.status}`)
    }

    const parent = node.parentId ? log.get(node.parentId) : undefined
    const compare = parent
      ? await this._eval().compare(parent.run, node.run)
      : undefined
    const requiresApproval = this.config.policy?.requiresApproval ?? false
    const checks = approved
      ? await evaluateGate(node, parent?.run, compare, this.config.policy)
      : []
    const allPassed = checks.every(check => check.ok)
    const status = !approved
      ? 'rejected'
      : node.run.aborted
        ? 'aborted'
        : allPassed
          ? 'accepted'
          : 'rejected'
    const failed = checks.filter(check => !check.ok)
    const reason = !approved
      ? 'rejected by approval'
      : status === 'aborted'
        ? `run aborted: ${node.run.abortedReason ?? 'unknown'}`
        : allPassed
          ? 'all gates passed'
          : `${failed.length} gates failed: ${failed.map(check => check.name).join(', ')}`
    const decision: SelectionDecision = {
      status,
      reason,
      checks,
      ...(requiresApproval ? { approved, requiresApproval: true } : {}),
    }
    if (compare) {
      decision.delta = compare.summary.delta
      decision.regressions = compare.summary.regressions
      decision.improvements = compare.summary.improvements
    }
    if (node.run.abortedReason) decision.abortedReason = node.run.abortedReason

    node.status = status
    node.decision = decision
    await log.update(node)
    if (status === 'accepted') await log.setBaseline(node.id)

    const event = { node, decision }
    if (status === 'accepted') this.ctx.emit('evolve/accept', event)
    else if (status === 'aborted') this.ctx.emit('evolve/abort', event)
    else this.ctx.emit('evolve/reject', event)
    return node
  }

  approve(nodeId: string, approved = true): Promise<ExperimentNode> {
    return this.decide(nodeId, approved)
  }

  async step(options: EvolveStepOptions = {}): Promise<EvolveStepResult> {
    const log = await this.init()
    const baseline = log.baseline
    let candidate = options.candidate
    if (!candidate) {
      const candidates = await this.propose({
        iteration: options.iteration ?? log.size,
        ...(baseline ? { baseline: baseline.run } : {}),
      })
      candidate = candidates[0]
    }
    if (!candidate) {
      return { kind: 'no-candidate', reason: 'no rules produced a candidate' }
    }

    const node = await this.evaluate(candidate, options.run ?? {})
    if (node.decision?.requiresApproval) {
      return { kind: 'approval-pending', node }
    }
    const decided = await this.decide(node.id)
    const kind = !decided.parentId && decided.status === 'accepted'
      ? 'established' as const
      : decided.status === 'accepted'
        ? 'accepted' as const
        : decided.status === 'aborted'
          ? 'aborted' as const
          : 'rejected' as const
    return { kind, node: decided }
  }

  async evolve(options: EvolveOptions = {}): Promise<EvolveStepResult> {
    const maxIterations = options.maxIterations ?? 10
    const maxRuns = options.maxRuns
    let evaluated = 0

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const stepOptions: EvolveStepOptions = {
        iteration,
        ...(iteration === 0 && options.candidate ? { candidate: options.candidate } : {}),
        ...(options.run ? { run: options.run } : {}),
      }
      const result = await this.step(stepOptions)
      if (result.kind === 'no-candidate') return result
      if (
        result.kind === 'established'
        || result.kind === 'accepted'
        || result.kind === 'aborted'
        || result.kind === 'approval-pending'
      ) {
        return result
      }
      evaluated += 1
      if (maxRuns !== undefined && evaluated >= maxRuns) {
        return { kind: 'no-candidate', reason: `maxRuns reached: ${maxRuns}` }
      }
    }

    return { kind: 'no-candidate', reason: `maxIterations reached: ${maxIterations}` }
  }

  async baseline(): Promise<ExperimentNode | undefined> {
    const log = await this.init()
    return log.baseline
  }

  async history(): Promise<ExperimentNode[]> {
    const log = await this.init()
    return log.nodes()
  }

  async replay(nodeId: string) {
    const log = await this.init()
    return log.replay(nodeId)
  }

  async loadLog(file?: string): Promise<ExperimentLog> {
    if (file) {
      this._log = await ExperimentLog.open(file)
      this._ready = Promise.resolve(this._log)
    }
    return this.init()
  }

  private _eval(): EvalService {
    const service = this.ctx.get('eval') as EvalService | undefined
    if (!service) throw new Error('evolve requires the eval plugin to be installed')
    return service
  }

  private _nodeByRunId(log: ExperimentLog, runId: string): ExperimentNode | undefined {
    return log.nodes().find(node => node.run.id === runId)
  }

  private _logFile(): string {
    return this.config.logFile ?? join(this.config.outputDir ?? '.tnega/experiments', 'log.json')
  }
}

export const evolvePlugin = {
  name: 'evolve',
  apply: async (ctx: Context, config: EvolvePluginConfig = {}) => {
    const service = new EvolveService(ctx, config)
    await service.init()
    ctx.provide('evolve', service)
    return () => {}
  },
}
