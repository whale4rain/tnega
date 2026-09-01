import type { ContextUsage, ModelMessage } from '@tnega/session'
import type { ToolDefinition, ToolResult } from '@tnega/tools'

export type AgentFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'max_turns'
  | 'max_steps'
  | 'error'
  | 'cancelled'

export interface LLMToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface LLMCompletion {
  content?: string
  toolCalls?: LLMToolCall[]
  finishReason: AgentFinishReason
}

export interface CompleteOptions {
  maxSteps?: number
  signal?: AbortSignal
}

export interface LLMMessageStartEvent {
  type: 'message_start'
  id: string
  model?: string
}

export interface LLMMessageDeltaEvent {
  type: 'message_delta'
  id: string
  delta: string
}

export interface LLMToolCallStartEvent {
  type: 'toolcall_start'
  id: string
  index: number
  name: string
}

export interface LLMToolCallEndEvent {
  type: 'toolcall_end'
  id: string
  index: number
  name: string
  arguments: unknown
}

export interface LLMMessageStopEvent {
  type: 'message_stop'
  id: string
  finishReason: AgentFinishReason
}

export type LLMStreamEvent =
  | LLMMessageStartEvent
  | LLMMessageDeltaEvent
  | LLMToolCallStartEvent
  | LLMToolCallEndEvent
  | LLMMessageStopEvent

export interface LLMAdapter {
  complete(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
    options: CompleteOptions,
  ): Promise<LLMCompletion>
  stream?(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
    options: CompleteOptions,
  ): AsyncIterable<LLMStreamEvent>
}

export interface AgentInput {
  text?: string
  messages?: ModelMessage[]
  context?: unknown
}

export interface AgentStep {
  index: number
  input: readonly ModelMessage[]
  completion: LLMCompletion
  toolResults: readonly ToolResult[]
}

export interface AgentRunResult {
  input: AgentInput
  output: string
  finishReason: AgentFinishReason
  steps: readonly AgentStep[]
  messages: readonly ModelMessage[]
}

export interface AgentRunOptions {
  maxTurns?: number
  maxSteps?: number
  signal?: AbortSignal
  contextBudget?: AgentContextBudget
}

export interface AgentContextBudget {
  limit?: number
  compactRatio?: number
  keepTokens?: number
  summarize?: AgentContextSummarizer
}

export type AgentContextSummarizer = (
  messages: readonly ModelMessage[],
  usage: ContextUsage,
) => readonly ModelMessage[] | Promise<readonly ModelMessage[]>

export interface AgentContextCompactEvent {
  type: 'agent/context-compact'
  messagesBefore: number
  tokensBefore: number
  limit: number
  keepTokens: number
  messagesAfter: number
}

export interface AgentHooks {
  beforeRun?: (input: AgentInput, options: AgentRunOptions) => void | Promise<void>
  afterRun?: (result: AgentRunResult, options: AgentRunOptions) => void | Promise<void>
}

export interface AgentStartEvent {
  input: AgentInput
  options: AgentRunOptions
  injected: ReadonlyMap<string, unknown>
}

export interface AgentTurnStartEvent {
  input: AgentInput
  messages: readonly ModelMessage[]
  injected: ReadonlyMap<string, unknown>
}

export interface AgentStepEvent {
  index: number
  input: readonly ModelMessage[]
}

export interface AgentPreStepEvent {
  index: number
  messages: ModelMessage[]
}

export interface AgentRequestEvent {
  index: number
  messages: ModelMessage[]
  tools: readonly ToolDefinition[]
  options: CompleteOptions
}

export interface AgentRequestErrorEvent {
  index: number
  messages: readonly ModelMessage[]
  tools: readonly ToolDefinition[]
  options: CompleteOptions
  attempt: number
  error: unknown
}

export type AgentRequestRetryDecision =
  | { kind: 'retry' }
  | undefined

export interface AgentTurnStoppingEvent {
  index: number
  steps: readonly AgentStep[]
  finishReason: AgentFinishReason
}

export interface AgentToolCallEvent {
  index: number
  call: LLMToolCall
}

export interface AgentToolResultEvent {
  index: number
  call: LLMToolCall
  result: ToolResult
}

export interface AgentTurnEndEvent {
  input: AgentInput
  steps: readonly AgentStep[]
  messages: readonly ModelMessage[]
  output: string
  finishReason: AgentFinishReason
}

export type AgentEndEvent = AgentTurnEndEvent

export interface AgentToolStartEvent {
  type: 'tool/start'
  index: number
  call: LLMToolCall
}

export interface AgentToolEndEvent {
  type: 'tool/end'
  index: number
  call: LLMToolCall
  result: ToolResult
}

export interface AgentRunEndEvent {
  type: 'run/end'
  run: AgentRunResult
}

export type AgentStreamEvent =
  | LLMStreamEvent
  | AgentToolStartEvent
  | AgentToolEndEvent
  | AgentRunEndEvent

export type AgentLoop = (
  input?: AgentInput,
  options?: AgentRunOptions,
) => Promise<AgentRunResult>
