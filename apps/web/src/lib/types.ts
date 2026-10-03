/**
 * Wire contract with the tnega server (`packages/cli/src/server.ts`).
 * Only the shapes this UI reads are modelled; unknown fields pass through.
 */

export type AgentType = 'general' | 'coding' | 'work'
export type SessionMode = 'auto' | 'plan' | 'goal'
export type Permission = 'read-only' | 'workspace-write' | 'bypass'
export type ApprovalMode = 'manual' | 'auto'
export interface ApprovalReviewerSettings {
  provider: 'conversation' | 'model' | 'jev' | 'openai'
  defaultMode: ApprovalMode
  modelId?: string
  model?: string
  baseUrl?: string
  apiKeyEnv?: string
  apiKeySet?: boolean
}
export type Effort = 'low' | 'medium' | 'high'
export type SessionEffort = 'default' | Effort
export type Protocol = 'anthropic' | 'openai'

export interface SessionSummary {
  id: string
  title: string
  workspace: string
  createdAt: number
  updatedAt: number
  eventCount: number
  parentSessionId?: string
  forkedAtMessageId?: string
  agentType?: AgentType
  mode?: SessionMode
  model?: string
  reasoningEffort?: SessionEffort
  permission?: Permission
  approvalMode?: ApprovalMode
}

export interface ErrorInfo {
  name?: string
  message: string
  stack?: string
}

export type CancelCause =
  | { type: 'user' }
  | { type: 'parent' }
  | { type: 'disposed' }
  | { type: 'abort'; message?: string }
  | { type: 'timeout'; timeoutMs: number }

export interface ToolCallRef {
  id: string
  name: string
  arguments: unknown
}

export interface PlanItem {
  id: string
  title: string
  status: 'pending' | 'done' | 'failed'
  detail?: string
}

export interface PlanPayload {
  items: PlanItem[]
  status?: 'pending' | 'running' | 'done' | 'failed'
  summary?: string
}

/** An image carried by a message or a tool result; base64 without a `data:` prefix. */
export interface ImageAttachment {
  type: 'image'
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
  name?: string
}

interface EventBase<T extends string, P> {
  id: string
  seq: number
  ts: number
  type: T
  payload: P
}

export type SessionEvent =
  | EventBase<'user/message', { content: string; name?: string; attachments?: ImageAttachment[] }>
  | EventBase<'assistant/message', {
      content: string
      name?: string
      interrupted?: boolean
      toolCalls?: ToolCallRef[]
    }>
  | EventBase<'system/message', { content: string }>
  | EventBase<'tool/call', { id: string; name: string; arguments: unknown }>
  | EventBase<'tool/result', {
      id: string
      toolCallId: string
      name: string
      ok: boolean
      durationMs?: number
      output?: unknown
      attachments?: ImageAttachment[]
      error?: ErrorInfo
    }>
  | EventBase<'plan', PlanPayload>
  | EventBase<'checkpoint', { summary?: string; tokensBefore?: number }>
  | EventBase<'meta', Record<string, unknown>>
  | EventBase<'llm/retry', { retryId: string; retry: number; delayMs?: number; failure?: ErrorInfo }>
  | EventBase<'turn/start', { turn: number }>
  | EventBase<'turn/end', {
      turn: number
      finishReason?: string
      reason?: { kind: string }
      interrupted?: boolean
      cancelCause?: CancelCause
      error?: ErrorInfo
    }>
  | EventBase<'step/end', {
      interrupted?: boolean
      cancelCause?: CancelCause
      error?: ErrorInfo
    }>
  // Anything else the log carries (chunks, request headers, compaction
  // bookkeeping…) is not part of the human-facing transcript.
  | EventBase<'other', unknown>

export interface ContextUsage {
  tokens: number
  limit: number
  ratio: number
  source?: 'provider' | 'estimate'
}

export interface SessionMetrics {
  responses: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheHitRate?: number
  tokensPerSecond?: number
  lastDurationMs?: number
}

export interface SessionDetail {
  summary: SessionSummary
  events: SessionEvent[]
  surface: SessionEvent[]
  context: ContextUsage
  metrics: SessionMetrics
  running: boolean
}

export interface GoalState {
  id: string
  objective: string
  status: 'active' | 'paused' | 'complete' | 'blocked'
  rounds: number
  maxRounds: number
  detail?: string
}

export interface SubagentEntry {
  id: string
  parentId: string
  label: string
  mode: 'spawn' | 'fork'
  status: 'running' | 'idle' | 'ready' | 'failed'
  createdAt: number
  updatedAt: number
  depth: number
  lastOutput?: string
}

export interface ModelOption {
  id: string
  name: string
  protocol: Protocol
  reasoningEfforts: Effort[]
  /** Whether the model accepts images. */
  vision?: boolean
  apiKeySet: boolean
  contextWindow?: number
}

export interface ConfigSnapshot {
  apiKeySet: boolean
  /** The config file exists but could not be parsed; saving is refused until it is fixed. */
  problem?: string
  effective: {
    baseUrl: string
    model: string
    modelId: string
    protocol?: Protocol
    reasoningEffort?: Effort
    temperature?: number
    contextWindow?: number
  }
  /** The shell the `shell` tool runs in now, and the ones this machine offers. */
  shell?: { active: string; available: ShellOption[] }
  config: {
    codeMode?: boolean
    /** Saved shell preference; empty means detect automatically. */
    shell?: string
    approvalReview?: ApprovalReviewerSettings
    apiKeySet: boolean
    path: string
    baseUrl?: string
    model?: string
    protocol?: Protocol
    reasoningEffort?: Effort
    temperature?: number
  }
  env: { apiKeySet: boolean; baseUrl?: string; model?: string }
  models: ModelOption[]
}

export interface ShellOption {
  path: string
  label: string
  kind: string
}

export interface SlashCommand {
  name: string
  description: string
}

export type SlashResult =
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: unknown }

export interface ToolResultWire {
  callId: string
  name: string
  ok: boolean
  output?: unknown
  attachments?: ImageAttachment[]
  error?: ErrorInfo
  durationMs?: number
}

/** Frames written to the `POST /runs` SSE stream. */
export type StreamEvent =
  | { type: 'session/compaction'; id: string; summary: string; tokensBefore?: number }
  | { type: 'ptc/dispatch'; payload: Record<string, unknown> }
  | { type: 'message_start'; id: string; model?: string }
  | { type: 'message_delta'; id: string; delta: string }
  | { type: 'message_stop'; id: string; finishReason: string }
  | { type: 'toolcall_start'; id: string; index: number; name: string }
  | { type: 'toolcall_end'; id: string; index: number; name: string; arguments: unknown }
  | { type: 'tool/start'; index: number; call: ToolCallRef }
  | { type: 'tool/end'; index: number; call: ToolCallRef; result: ToolResultWire }
  | { type: 'plan/start' }
  | { type: 'plan/items'; plan: PlanPayload }
  | { type: 'plan/item'; item: PlanItem }
  | { type: 'plan/done'; plan: PlanPayload }
  | { type: 'plan/error'; message: string }
  | { type: 'run/end'; run: { output: string; finishReason: string } }
  | { type: 'approval/request'; id: string; tool: string; input: string }
  | { type: 'assistant/stream' }
  | { type: 'done' }
  | { type: 'error'; message: string }
export interface UserQuestionOption {
  label: string
  description?: string
}

export interface UserQuestion {
  id: string
  question?: string
  options?: UserQuestionOption[]
  multiple?: boolean
  optional?: boolean
}

export interface PendingQuestionRequest {
  requestId: string
  agentId: string
  callId?: string
  mode: 'blocking' | 'nonblocking'
  questions: UserQuestion[]
  createdAt: number
  status: 'pending'
}

export interface QuestionAnswerItem {
  questionId: string
  selected?: string[]
  text?: string
}
