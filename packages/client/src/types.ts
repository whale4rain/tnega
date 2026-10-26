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
  /** A run is going now; the sidebar shows it as working. */
  running?: boolean
  /** Its approval card is open, so it needs you before it can go on. */
  waiting?: boolean
}

/** A session whose messages match a search, with a stretch of the matching message. */
export interface SessionSearchHit {
  id: string
  snippet: string
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
      /** Reasoning the provider exposed for this response. */
      reasoning?: string
      /** Committed stream chunks with their arrival times. */
      stream?: Array<{ time: number; chunk: { type: string } }>
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
  | EventBase<'meta/patch', { fields: string[]; model?: string; reasoningEffort?: SessionEffort }>
  | EventBase<'permission/mode', { mode: Permission }>
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

/** Token use and estimated spend over a span (`GET /api/usage`, session detail). */
export interface UsageTotals {
  responses: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  reasoningTokens: number
  cacheHitRate?: number
  cost?: Array<{ amount: number; currency: string }>
}

export interface WorkspaceUsage {
  today: UsageTotals
  week: UsageTotals
  total: UsageTotals
  byModel: Array<UsageTotals & { modelId: string; name: string; priced: boolean }>
  sessions: number
  responses: UsageResponse[]
}

export interface UsageResponse extends UsageTotals {
  sessionId: string
  sessionTitle: string
  timestamp: number
  modelId: string
  projectId?: string
  threadId?: string
}

/** What a request's prompt holds (`GET /api/context`). */
export type ContextCategory = 'system' | 'tools' | 'user' | 'injected' | 'assistant' | 'results'
export type ContextComposition = Record<ContextCategory, number>
export type CostList = Array<{ amount: number; currency: string }>

/** Where active time went: model calls split by what the stream was doing, then tools and the rest. */
export interface ContextTiming {
  activeMs: number
  waitingMs: number
  thinkingMs: number
  respondingMs: number
  toolMs: number
  otherMs: number
  modelCalls: number
  toolRuns: number
}

/** One model request of a session. */
export interface ContextStep {
  turn: number
  step: number
  ts: number
  modelId: string
  estimate: ContextComposition
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  reasoningTokens?: number
  cost?: { amount: number; currency: string }
  compacted?: boolean
  toolCalls: number
  timing: Omit<ContextTiming, 'activeMs' | 'otherMs' | 'modelCalls'>
}

export interface ContextCurrent {
  estimate: ContextComposition
  tokens: number
  source: 'provider' | 'estimate'
}

/** One session's context (`GET /api/context`). */
export interface SessionContextReport {
  title: string
  model?: string
  window: number
  compactAt: number
  current: ContextCurrent
  stats: {
    turns: number
    steps: number
    userInputs: number
    toolCalls: number
    toolErrors: number
    compactions: number
    promptTokens: number
    completionTokens: number
    cachedTokens: number
    reasoningTokens: number
    cacheHitRate?: number
    cost?: CostList
    pricedSteps: number
  }
  billed: { composition: ContextComposition; output: number }
  timing: ContextTiming
  steps: ContextStep[]
  turns: Array<{ turn: number; start: number; end: number }>
  lastMessage?: string
  updatedAt: number
}

export type InsightsRange = 'today' | '7d' | '30d' | 'all'

export interface InsightsSession {
  id: string
  kind: 'session' | 'thread'
  projectId?: string
  threadId?: string
  title: string
  model?: string
  updatedAt: number
  lastMessage?: string
  window: number
  current: ContextCurrent
  turns: number
  steps: number
  tokens: number
  cost?: CostList
  days: string[]
}

export interface InsightsDay {
  date: string
  tokens: number
  steps: number
  cost?: CostList
}

/**
 * Which better sandbox this machine could still install (`GET /api/sandbox/setup`).
 * `missing` means Windows is new enough for Microsoft MXC but its executor is not installed.
 */
export interface SandboxSetup {
  mxc: 'unsupported' | 'disabled' | 'missing' | 'installed'
  install: { command: string; url: string }
}

/**
 * Whether this machine's sandbox can filter command network by domain (`GET /api/sandbox/network`).
 * When `filtering` is false, "listed domains only" and "off" make commands refuse to run; `detail` says why.
 */
export interface SandboxNetworkSupport {
  filtering: boolean
  runner?: string
  detail?: string
}

/** How commands run by the agent may reach the network. */
export type CommandNetworkMode = 'open' | 'allowlist' | 'off'

export interface CommandNetworkSettings {
  mode: CommandNetworkMode
  allowedDomains: string[]
  deniedDomains: string[]
}

/** The workspace roll-up behind Settings → Context insights (`GET /api/context-insights`). */
export interface ContextInsights {
  range: InsightsRange
  from?: number
  generatedAt: number
  sessionCount: number
  activeSessions: number
  totals: {
    promptTokens: number
    completionTokens: number
    cachedTokens: number
    cacheHitRate?: number
    cost?: CostList
    pricedSessions: number
    turns: number
    steps: number
    toolCalls: number
  }
  billed: { composition: ContextComposition; output: number }
  timing: ContextTiming
  week: InsightsDay[]
  activity: InsightsDay[]
  sessions: InsightsSession[]
}

/** Where a ChatGPT sign-in stands (`/api/auth/chatgpt`). */
export type ChatGptLoginState =
  | { status: 'signed-out' }
  | { status: 'pending'; url: string }
  | { status: 'signed-in'; email?: string }
  | { status: 'error'; message: string }

/** Prices per million tokens for a model route. */
export interface ModelPricing {
  input: number
  output: number
  cachedInput?: number
  currency?: string
}

export interface SessionDetail {
  summary: SessionSummary
  events: SessionEvent[]
  /** Where this transcript window starts; a long history arrives a page at a time. */
  page?: SessionPageRange
  context: ContextUsage
  metrics: SessionMetrics
  usage?: UsageTotals
  running: boolean
  /** The last turn was cut off by a crash or restart and nothing has continued it. */
  recovery?: SessionRecovery
}

export interface SessionPageRange {
  /** Earlier events exist before the window. */
  hasMore: boolean
  /** Pass as beforeSeq for the next older page; absent once the log is covered. */
  beforeSeq?: number
}

export interface SessionRecovery {
  /** Continuing needs no confirmation: no cut-off call may already have taken effect. */
  safe: boolean
  /** Tools whose cut-off calls may already have taken effect. */
  uncertainCalls: string[]
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

export type ModelSource = 'provider' | 'third-party'

export interface ModelDiscoveryInput {
  routeId?: string
  auth?: 'chatgpt'
  protocol?: Protocol
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
}

export interface DiscoveredModel {
  id: string
  name: string
  contextWindow?: number
  vision?: boolean
}

export interface ModelDiscovery {
  models: DiscoveredModel[]
  source: ModelSource
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
  source?: ModelSource
}

/** A registered chat model route as stored in the config file (no key, only whether one is set). */
export interface ModelRouteSettings {
  id: string
  model?: string
  name?: string
  baseUrl?: string
  protocol?: Protocol
  apiKeyEnv?: string
  apiKeySet: boolean
  contextWindow?: number
  vision?: boolean
  pricing?: ModelPricing
  /** `chatgpt` when the route signs in with ChatGPT instead of an API key. */
  auth?: 'chatgpt'
  source?: ModelSource
}

/** What the model route form sends; a blank key keeps the saved one. */
export interface ModelRouteInput {
  name?: string
  model: string
  protocol?: Protocol | ''
  baseUrl?: string
  apiKey?: string
  contextWindow?: number
  vision?: boolean
  /** `null` clears saved prices. */
  pricing?: ModelPricing | null
  auth?: 'chatgpt'
  source?: ModelSource
  sourceRouteId?: string
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
  /** How the HTTP tools reach the network. */
  network?: {
    allowedHosts: string[]
    proxy: string
    /** Hosts trusted out of the box. */
    defaultAllowedHosts: string[]
    /** The proxy HTTPS_PROXY / HTTP_PROXY sets, without credentials. */
    environmentProxy?: string
  }
  /** Network rules for commands the agent runs (shell and processes), enforced by the sandbox. */
  sandbox?: { network: CommandNetworkSettings }
  config: {
    projectMemory?: ProjectMemorySettings
    memoryDream?: MemoryDreamSettings
    codeMode?: boolean
    /** How strictly a file write must match what the Session already read. */
    fsGuard?: FsGuardMode
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
    /** Registered chat model routes. */
    models?: ModelRouteSettings[]
  }
  env: { apiKeySet: boolean; baseUrl?: string; model?: string }
  models: ModelOption[]
}

export interface ProjectMemorySettings {
  enabled?: boolean
  coldModelId?: string
  maxCallsPerDay?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxTokensPerDay?: number
  minIntervalSeconds?: number
}

/** Dreaming: quiet sessions are folded into project memory in the background. */
export interface MemoryDreamSettings {
  enabled?: boolean
  /** Model route a dream uses; empty uses the default route. */
  modelId?: string
  idleMinutes?: number
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
  | { type: 'reasoning_delta'; id: string; delta: string }
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
  | { type: 'approval/request'; id: string; tool: string; input: string; via?: 'run_code' }
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
  /** A secret question: the environment variable its hidden answer becomes. */
  secret?: string
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
  /** For a secret question, the value; it goes to the host's secret store, not the Session. */
  text?: string
  /** A secret question only: save it for every session in this workspace. */
  remember?: boolean
}

/** A secret by name; values never come back from the server. */
export interface SecretInfo {
  name: string
  /** Saved for the workspace rather than kept for this session only. */
  remembered: boolean
}

/** The file write guard's modes (mirrors `@tnega/config`, which the browser cannot import). */
export const FS_GUARD_MODES = ['off', 'warn', 'enforce'] as const
export type FsGuardMode = typeof FS_GUARD_MODES[number]

export function isFsGuardMode(value: unknown): value is FsGuardMode {
  return FS_GUARD_MODES.some(mode => mode === value)
}
