import type { Plugin } from '@tnega/core'
import type {
  CandidatePreset,
  CompareResult,
  EvalRun,
  EvalRunOptions,
  RunBudget,
  Task,
  VerdictStatus,
} from '@tnega/eval'

export interface CandidateMutation {
  type: string
  description: string
  patch?: Record<string, unknown>
  config?: Record<string, unknown>
}

export interface Candidate {
  name: string
  version?: string
  config?: Record<string, unknown>
  model?: Record<string, unknown>
  plugin: Plugin
  mutation?: CandidateMutation
  rationale?: string
}

export type CandidateSnapshot = Omit<Candidate, 'plugin'>

export interface FailureMode {
  taskId: string
  strategy: string
  status: VerdictStatus
  score: number
  reason?: string
}

export interface StrategySummary {
  total: number
  passed: number
  failed: number
  errors: number
}

export interface Diagnosis {
  score: number
  total: number
  passed: number
  failed: number
  errors: number
  aborted: boolean
  abortedReason?: string
  failureModes: FailureMode[]
  failingTasks: string[]
  strategySummary: Record<string, StrategySummary>
}

export interface ProposalContext {
  baseline?: EvalRun
  diagnosis: Diagnosis
  iteration: number
  history: readonly ExperimentNode[]
  rules: readonly ProposeRule[]
}

export type ProposeRuleResult = Candidate | readonly Candidate[] | null | undefined

export interface ProposeRule {
  id: string
  description?: string
  apply(context: ProposalContext): ProposeRuleResult | Promise<ProposeRuleResult>
}

export type ExperimentStatus = 'pending' | 'accepted' | 'rejected' | 'aborted' | 'error'

export interface GateCheck {
  name: string
  ok: boolean
  detail: string
}

export interface SelectionDecision {
  status: ExperimentStatus
  reason: string
  checks: GateCheck[]
  approved?: boolean
  requiresApproval?: boolean
  delta?: number
  regressions?: string[]
  improvements?: string[]
  abortedReason?: string
}

export interface ApprovalRequest {
  nodeId: string
  candidate: CandidateSnapshot
  run: EvalRun
  baseline?: EvalRun
}

export interface SelectionPolicy {
  minScore?: number
  requiredStrategies?: string[]
  safetyStrategies?: string[]
  safetyTasks?: string[]
  maxDegradation?: number
  maxRegressions?: number
  maxRegressionRatio?: number
  minDelta?: number
  minPairs?: number
  requireImprovement?: boolean
  requiresApproval?: boolean
  significance?: (compare: CompareResult, policy: SelectionPolicy) => boolean | Promise<boolean>
}

export interface ExperimentNode {
  id: string
  parentId?: string
  candidate: CandidateSnapshot
  run: EvalRun
  status: ExperimentStatus
  createdAt: number
  decision?: SelectionDecision
}

export interface ExperimentLogData {
  version: 1
  id: string
  createdAt: number
  updatedAt: number
  baselineId?: string
  nodes: Record<string, ExperimentNode>
}

export interface ExperimentReplay {
  node: ExperimentNode
  diagnosis: Diagnosis
  history: string[]
  baseline?: ExperimentNode
}

export type EvolveStepResult =
  | { kind: 'established'; node: ExperimentNode }
  | { kind: 'accepted'; node: ExperimentNode }
  | { kind: 'rejected'; node: ExperimentNode }
  | { kind: 'aborted'; node: ExperimentNode }
  | { kind: 'approval-pending'; node: ExperimentNode }
  | { kind: 'no-candidate'; reason: string }

export interface EvolveStepOptions {
  candidate?: Candidate
  establishBaseline?: boolean
  iteration?: number
  run?: Partial<EvalRunOptions>
}

export interface EvolveOptions {
  maxIterations?: number
  maxRuns?: number
  candidate?: Candidate
  run?: Partial<EvalRunOptions>
}

export interface EvolvePluginConfig {
  outputDir?: string
  logFile?: string
  policy?: SelectionPolicy
  rules?: ProposeRule[]
  tasks?: readonly Task[]
  strategyNames?: string[]
  budget?: RunBudget
  cache?: boolean
}

export interface EvolveRunEvent {
  nodeId: string
  runId: string
  candidate: CandidateSnapshot
}

export interface EvolveApprovalEvent {
  node: ExperimentNode
  request: ApprovalRequest
}

export interface EvolveDecisionEvent {
  node: ExperimentNode
  decision: SelectionDecision
}

export interface EvolveProposeEvent {
  iteration: number
  baselineRunId?: string
  candidates: CandidateSnapshot[]
}

export type { CandidatePreset }
