export interface SessionSummary {
  id: string
  title: string
  workspace: string
  createdAt: number
  updatedAt: number
  eventCount: number
}

export interface SessionEventBase<T extends string, P> {
  id: string
  seq: number
  ts: number
  type: T
  payload: P
}

export interface MessagePayload {
  role: 'system' | 'user' | 'assistant'
  content: string
  name?: string
}

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
  output?: unknown
  error?: { message: string; stack?: string }
}

export type SessionEvent =
  | SessionEventBase<'message', MessagePayload>
  | SessionEventBase<'tool-call', ToolCallPayload>
  | SessionEventBase<'tool-result', ToolResultPayload>
  | SessionEventBase<'checkpoint', {
      messages: ModelMessage[]
      summary?: string
      tokensBefore?: number
      snapshot?: SessionEvent[]
    }>
  | SessionEventBase<'meta', Record<string, unknown>>

export interface SessionDetail {
  summary: SessionSummary
  events: SessionEvent[]
  context: ContextUsage
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
  error?: { message: string; stack?: string }
}

export type StreamEvent =
  | { type: 'message_start'; id: string; model?: string }
  | { type: 'message_delta'; id: string; delta: string }
  | { type: 'message_stop'; id: string; finishReason: string }
  | { type: 'toolcall_start'; id: string; index: number; name: string }
  | { type: 'toolcall_end'; id: string; index: number; name: string; arguments: unknown }
  | { type: 'tool/start'; index: number; call: ToolCall }
  | { type: 'tool/end'; index: number; call: ToolCall; result: ToolResult }
  | { type: 'run/end'; run: { output: string; finishReason: string } }
  | { type: 'done' }
  | { type: 'error'; message: string }

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
  finishReason?: string
  pending?: boolean
  compacted?: boolean
  tokensBefore?: number
}
