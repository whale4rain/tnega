import type { Context, Plugin } from '@tnega/core'
import type { AgentRunResult } from '@tnega/agent'
import type { ModelMessage } from '@tnega/session'

export type VerdictStatus = 'pass' | 'fail' | 'skip' | 'error'

export interface TaskAssertion {
  /** Exact output match, or a list of required substrings. */
  expect?: string | string[]
  /** Files that must exist, or a function checking files. */
  files?: string[] | ((evidence: Evidence) => boolean | Promise<boolean>)
  /** Arbitrary predicate over evidence and task. */
  check?: (evidence: Evidence, task: Task) => boolean | Promise<boolean>
}

export interface TaskBudget {
  maxTurns?: number
  maxSteps?: number
  maxTimeMs?: number
  maxTokens?: number
  maxCost?: number
}

export interface Task {
  id: string
  name?: string
  description?: string
  input?: unknown
  inputText?: string
  messages?: ModelMessage[]
  assertion?: TaskAssertion
  strategies?: string[]
  budget?: TaskBudget
  artifacts?: Record<string, unknown>
}

export interface CandidateMetadata {
  name: string
  version?: string
  config?: Record<string, unknown>
  model?: Record<string, unknown>
}

export interface CandidatePreset {
  plugin: Plugin
  name: string
  version?: string
  config?: Record<string, unknown>
  model?: Record<string, unknown>
}

export interface Evidence {
  task: Task
  agentResult?: AgentRunResult
  messages: ModelMessage[]
  artifacts: Record<string, unknown>
  strategyOutputs: Record<string, unknown>
}

export interface Verdict {
  taskId: string
  strategy: string
  status: VerdictStatus
  score: number
  reason?: string
  output?: unknown
  meta?: Record<string, unknown>
}

export interface RunBudget {
  maxTurns?: number
  maxTokens?: number
  maxCost?: number
  maxTimeMs?: number
}

export interface BudgetUsage {
  turns: number
  tokens: number
  cost: number
  timeMs: number
}

export interface EvalRun {
  id: string
  createdAt: number
  candidate: CandidateMetadata
  taskIds: string[]
  verdicts: Verdict[]
  summary: {
    total: number
    passed: number
    failed: number
    skipped: number
    errors: number
    score: number
    budget: BudgetUsage
  }
  cacheHits: number
  cacheKey?: string
  modelConfigHash?: string
  baselineRunId?: string
  aborted: boolean
  abortedReason?: string
  error?: {
    message: string
    stack?: string
  }
}

export interface EvalRunOptions {
  candidate: CandidatePreset
  tasks: readonly Task[]
  strategyNames?: string[]
  baselineRunId?: string
  budget?: RunBudget
  cache?: boolean
  cacheDir?: string
  outputFile?: string
  runCandidate?: (ctx: Context, task: Task) => Promise<AgentRunResult>
}

export interface StrategyContext {
  ctx: Context
  run: Pick<EvalRun, 'id' | 'candidate'>
  baseline?: EvalRun
}

export interface EvalStrategy {
  name: string
  evaluate(ctx: StrategyContext, task: Task, evidence: Evidence): Verdict | Promise<Verdict>
  dispose?(): void | Promise<void>
}

export interface EvalStrategyDefinition {
  name: string
  evaluate: EvalStrategy['evaluate']
}

export interface CompareResult {
  base: EvalRun
  head: EvalRun
  summary: {
    baseScore: number
    headScore: number
    delta: number
    passed: number
    failed: number
    regressions: string[]
    improvements: string[]
  }
  taskResults: Array<{
    taskId: string
    base: Verdict | undefined
    head: Verdict | undefined
    delta: number
    changed: boolean
  }>
}

export interface EvalPluginConfig {
  strategyNames?: string[]
  defaultBudget?: RunBudget
  outputDir?: string
  llmJudge?: (task: Task, evidence: Evidence) => Promise<number> | number
  gate?: {
    required?: string[]
    thresholds?: Record<string, number>
    minScore?: number
  }
}

export interface EvalStartEvent {
  runId: string
  candidate: CandidateMetadata
  taskIds: string[]
  budget: RunBudget
}

export interface EvalTaskStartEvent {
  runId: string
  task: Task
  scope: Context
}

export interface EvalTaskEndEvent {
  runId: string
  task: Task
  evidence: Evidence
  durationMs: number
  fromCache: boolean
}

export interface EvalVerdictEvent {
  runId: string
  taskId: string
  verdict: Verdict
}

export interface EvalRunEndEvent {
  run: EvalRun
}

export interface EvalAbortEvent {
  runId: string
  taskId?: string
  reason: string
}
