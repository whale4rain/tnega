import type { Context, Plugin } from '@tnega/core'
import type { AgentRunResult, LLMAdapter } from '@tnega/agent'
import type { ModelMessage } from '@tnega/session'

export type VerdictStatus = 'pass' | 'fail' | 'skip' | 'error'

export interface EvalWorkspaceFixture {
  /** Template directory relative to the tasks file. */
  root?: string
  /** Explicit file entries; use content or from. */
  files?: Array<{ path: string; content?: string; from?: string }>
}

export interface EvalShellPolicy {
  enabled: boolean
  /** Allowed command prefixes, e.g. ["pytest", "pip install", "node"]. */
  allow?: string[]
  /** Denied command prefixes, e.g. ["rm", "taskkill"]. */
  deny?: string[]
}

export interface TaskPermissions {
  /** Tool whitelist; defaults to the safe builtin set. */
  tools?: string[]
  /** Shell policy; disabled by default. */
  shell?: EvalShellPolicy
  /** Network tools; false by default. */
  network?: boolean
  /** Skill tools; follows candidate config by default. */
  skills?: boolean
  /** MCP is always false during eval. */
  mcp?: boolean
}

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
  fixture?: EvalWorkspaceFixture
  /** Setup command or hook, run inside the workspace before the agent. */
  setup?: string | ((workspace: string) => void | Promise<void>)
  /** Success check: command (exit 0) or predicate. */
  check?: string | ((evidence: Evidence, workspace: string) => boolean | Promise<boolean>)
  /** Teardown command or hook, run after the trial. */
  teardown?: string | ((workspace: string) => void | Promise<void>)
  /** Default 3; must be >= 1. */
  trials?: number
  permissions?: TaskPermissions
  /** Default 'train'. */
  split?: 'train' | 'val'
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

export interface TrialTraceMetrics {
  steps: number
  turns: number
  toolCalls: number
  toolErrors: number
  invalidToolCalls: number
  retries: number
  tokens: number
  cost: number
  recoveredAfterError: boolean
}

export interface TrialTrace {
  file: string
  startedAt: number
  endedAt: number
  durationMs: number
  metrics: TrialTraceMetrics
}

export interface TrialEvidence {
  trial: number
  verdicts: Verdict[]
  trace: TrialTrace
  agentResult?: AgentRunResult
  artifacts: Record<string, unknown>
}

export interface Evidence {
  task: Task
  agentResult?: AgentRunResult
  messages: ModelMessage[]
  artifacts: Record<string, unknown>
  strategyOutputs: Record<string, unknown>
  trials?: TrialEvidence[]
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
  trialSummaries?: TrialSummary[]
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

export interface TrialSummary {
  taskId: string
  trials: number
  passed: number
  passRate: number
  scoreMean: number
  scoreMedian: number
  scoreStddev: number
  costMean: number
  stepsMean: number
}

export interface CodingEvalAgentConfig {
  systemPrompt?: string
  maxTurns?: number
  maxSteps?: number
}

export interface CodingEvalCodingConfig {
  skills?: boolean
  planTools?: boolean
  mcp?: boolean
  planPrompt?: string
}

export interface CodingEvalConfig {
  llm: LLMAdapter
  agent?: CodingEvalAgentConfig
  coding?: CodingEvalCodingConfig
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
  coding?: CodingEvalConfig
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
