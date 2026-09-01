export interface SessionSummary {
  id: string
  title: string
  workspace: string
  createdAt: number
  updatedAt: number
  eventCount: number
  parentSessionId?: string
  forkedAtMessageId?: string
  agentType?: 'general' | 'coding'
  mode?: 'auto' | 'plan' | 'execute'
}

export interface SessionEventBase<T extends string, P> {
  id: string
  seq: number
  ts: number
  type: T
  payload: P
}

export interface UserMessagePayload {
  content: string
  name?: string
}

export interface AssistantMessagePayload {
  content: string
  name?: string
}

export interface SystemMessagePayload {
  content: string
  name?: string
}

export type MessageEventPayload =
  | UserMessagePayload
  | AssistantMessagePayload
  | SystemMessagePayload

export interface ToolCallPayload {
  id: string
  name: string
  arguments: unknown
}

export interface ToolResultPayload {
  id: string
  toolCallId: string
  name: string
  ok: boolean
  durationMs?: number
  output?: unknown
  error?: { name?: string; message: string; stack?: string }
}

export type CancelCause =
  | { type: 'user' }
  | { type: 'abort'; message?: string }
  | { type: 'timeout'; timeoutMs: number }

export type PlanItemStatus = 'pending' | 'done' | 'failed'

export type PlanStatus = 'pending' | 'running' | 'done' | 'failed'

export interface PlanPayload {
  items: Array<{
    id: string
    title: string
    status: PlanItemStatus
    detail?: string
  }>
  status?: PlanStatus
  summary?: string
}

export type SessionEvent =
  | SessionEventBase<'user/message', UserMessagePayload>
  | SessionEventBase<'assistant/message', AssistantMessagePayload>
  | SessionEventBase<'system/message', SystemMessagePayload>
  | SessionEventBase<'tool/call', ToolCallPayload>
  | SessionEventBase<'tool/result', ToolResultPayload>
  | SessionEventBase<'plan', PlanPayload>
  | SessionEventBase<'checkpoint', {
      messages: ModelMessage[]
      summary?: string
      tokensBefore?: number
      surfaceOp?: 'replace'
      snapshot?: SessionEvent[]
    }>
  | SessionEventBase<'meta', Record<string, unknown>>
  | SessionEventBase<'llm/retry', {
      attempt: number
      error?: { name?: string; message: string; stack?: string }
    }>
  | SessionEventBase<'llm/retry-started', { attempt: number }>
  | SessionEventBase<'turn/start', {
      input?: unknown
      reason?: string
    }>
  | SessionEventBase<'turn/end', {
      finishReason?: string
      output?: string
      steps?: number
      interrupted?: boolean
      cancelCause?: CancelCause
      error?: { name?: string; message: string; stack?: string }
    }>
  | SessionEventBase<'step/start', { index: number }>
  | SessionEventBase<'step/end', {
      index: number
      finishReason?: string
      toolCalls?: number
      interrupted?: boolean
      cancelCause?: CancelCause
      error?: { name?: string; message: string; stack?: string }
    }>

export interface SessionDetail {
  summary: SessionSummary
  events: SessionEvent[]
  context: ContextUsage
  running: boolean
}

export interface ContextUsage {
  tokens: number
  limit: number
  ratio: number
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; name: string; arguments: unknown }>
  toolOk?: boolean
  toolError?: { name?: string; message: string; stack?: string }
}

export interface LlmEffective {
  baseUrl: string
  model: string
  temperature?: number
}

export interface ConfigSnapshot {
  apiKeySet: boolean
  effective: LlmEffective
  config: {
    apiKeySet: boolean
    baseUrl?: string
    model?: string
    temperature?: number
  }
  env: {
    apiKeySet: boolean
    baseUrl?: string
    model?: string
  }
}

export interface ToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface ToolResult {
  callId: string
  name: string
  ok: boolean
  output?: unknown
  error?: { name?: string; message: string; stack?: string }
  startedAt?: number
  durationMs?: number
}

export type StreamEvent =
  | { type: 'message_start'; id: string; model?: string }
  | { type: 'message_delta'; id: string; delta: string }
  | { type: 'message_stop'; id: string; finishReason: string }
  | { type: 'toolcall_start'; id: string; index: number; name: string }
  | { type: 'toolcall_end'; id: string; index: number; name: string; arguments: unknown }
  | { type: 'tool/start'; index: number; call: ToolCall }
  | { type: 'tool/end'; index: number; call: ToolCall; result: ToolResult }
  | { type: 'plan/start' }
  | { type: 'plan/items'; plan: PlanPayload }
  | { type: 'plan/item'; item: PlanPayload['items'][number] }
  | { type: 'plan/done'; plan: PlanPayload }
  | { type: 'plan/error'; message: string }
  | { type: 'run/end'; run: { output: string; finishReason: string } }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface SlashCommand {
  name: string
  description: string
}

export interface SlashSuggestion {
  command: string
  args: string[]
  label: string
  detail?: string
}

export type SlashCommandResult =
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: unknown }

export interface SlashMetaPayload {
  kind: 'slash'
  command: string
  args: string[]
  result: SlashCommandResult
}

export interface DisplayTool {
  callId: string
  name: string
  argumentsText: string
  status: 'pending' | 'done'
  ok?: boolean
  outputText?: string
  errorText?: string
}

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  tool?: DisplayTool
  slash?: SlashMetaPayload
  finishReason?: string
  pending?: boolean
  compacted?: boolean
  tokensBefore?: number
}
