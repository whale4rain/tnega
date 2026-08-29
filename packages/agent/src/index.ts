import type { Context } from '@tnega/core'
import type { ModelMessage, SessionLog, ToolResultPayload } from '@tnega/session'
import type { ToolDefinition, ToolResult } from '@tnega/tools'
import type { ToolsService } from '@tnega/tools'

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
}

export interface AgentConfig {
  llm?: LLMAdapter
  maxTurns?: number
  maxSteps?: number
  inbox?: AgentInbox
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

export type AgentLoop = (
  input?: AgentInput,
  options?: AgentRunOptions,
) => Promise<AgentRunResult>

export class AgentError extends Error {
  override name = 'AgentError'
}

export class AgentInbox {
  private _queue: AgentInput[] = []
  private _injected = new Map<string, unknown>()

  get size(): number {
    return this._queue.length
  }

  push(input: AgentInput): AgentInput {
    this._queue.push(input)
    return input
  }

  claim(): AgentInput | undefined {
    return this._queue.shift()
  }

  peek(): AgentInput | undefined {
    return this._queue[0]
  }

  inject(key: string, value: unknown): void {
    this._injected.set(key, value)
  }

  injected(): ReadonlyMap<string, unknown> {
    return new Map(this._injected)
  }
}

function copyMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    const copy: ModelMessage = {
      role: message.role,
      content: message.content,
    }
    if (message.name) copy.name = message.name
    if (message.tool_call_id) copy.tool_call_id = message.tool_call_id
    if (message.tool_calls) {
      copy.tool_calls = message.tool_calls.map(call => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      }))
    }
    return copy
  })
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function copyCompletion(completion: LLMCompletion): LLMCompletion {
  const copy: LLMCompletion = {
    finishReason: completion.finishReason,
  }
  if (completion.content !== undefined) copy.content = completion.content
  if (completion.toolCalls) {
    copy.toolCalls = completion.toolCalls.map(call => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    }))
  }
  return copy
}

export class AgentService {
  readonly inbox: AgentInbox

  constructor(
    private ctx: Context,
    private config: AgentConfig = {},
  ) {
    this.inbox = config.inbox ?? new AgentInbox()
  }

  async run(input?: AgentInput, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const claimed = input ?? this.inbox.claim()
    if (!claimed) throw new AgentError('no agent input available')

    const session = this._session()
    const tools = this._tools()
    const llm = this._llm()
    if (!llm) throw new AgentError('no LLM adapter available')

    const maxTurns = options.maxTurns ?? this.config.maxTurns ?? 8
    const maxSteps = options.maxSteps ?? this.config.maxSteps ?? 64
    const injected = this.inbox.injected()
    this.ctx.emit('agent/start', { input: claimed, options, injected })

    let messages = this._initialMessages(claimed)
    if (claimed.text) {
      await session.append('message', { role: 'user', content: claimed.text })
    }

    const steps: AgentStep[] = []
    let output = ''
    let finishReason: AgentFinishReason = 'stop'

    this.ctx.emit('agent/turn-start', {
      input: claimed,
      messages: copyMessages(messages),
      injected,
    })

    for (let index = 0; index < maxTurns; index++) {
      if (options.signal?.aborted) {
        finishReason = 'error'
        break
      }
      if (steps.length >= maxSteps) {
        finishReason = 'max_steps'
        break
      }

      const stepInput = copyMessages(messages)
      this.ctx.emit('agent/step', { index, input: copyMessages(stepInput) })
      const completeOptions: CompleteOptions = {
        maxSteps: maxSteps - steps.length,
      }
      if (options.signal) completeOptions.signal = options.signal
      const completion = await llm.complete(stepInput, tools.list(), completeOptions)

      const toolCalls = completion.toolCalls ?? []
      const toolResults: ToolResult[] = []
      if (toolCalls.length) {
        await session.append('message', {
          role: 'assistant',
          content: completion.content ?? '',
        })
      }
      for (const call of toolCalls) {
        this.ctx.emit('agent/tool-call', { index, call })
        await session.append('tool-call', {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })
        const result = await tools.execute(call.name, call.arguments, { callId: call.id })
        toolResults.push(result)
        const toolResultPayload: ToolResultPayload = {
          id: call.id,
          toolCallId: call.id,
          name: call.name,
          ok: result.ok,
        }
        if (result.output !== undefined) toolResultPayload.output = result.output
        if (result.error) {
          toolResultPayload.error = {
            message: result.error.message,
          }
          if (result.error.stack) toolResultPayload.error.stack = result.error.stack
        }
        await session.append('tool-result', toolResultPayload)
        this.ctx.emit('agent/tool-result', { index, call, result })
      }

      steps.push({
        index,
        input: stepInput,
        completion,
        toolResults,
      })

      if (completion.content) {
        output = completion.content
      }
      if (!toolCalls.length) {
        await session.append('message', { role: 'assistant', content: completion.content ?? '' })
      }

      messages = this._extendMessages(messages, completion, toolResults)
      if (toolCalls.length === 0) {
        finishReason = completion.finishReason === 'length'
          ? 'length'
          : completion.finishReason === 'error'
            ? 'error'
            : 'stop'
        break
      }
      if (index + 1 >= maxTurns) {
        finishReason = 'max_turns'
      } else {
        finishReason = 'tool_calls'
      }
    }

    this.ctx.emit('agent/turn-end', {
      input: claimed,
      steps: copySteps(steps),
      messages: copyMessages(messages),
      output,
      finishReason,
    })
    this.ctx.emit('agent/end', {
      input: claimed,
      steps: copySteps(steps),
      messages: copyMessages(messages),
      output,
      finishReason,
    })

    return {
      input: claimed,
      output,
      finishReason,
      steps,
      messages: copyMessages(messages),
    }
  }

  private _initialMessages(input: AgentInput): ModelMessage[] {
    if (input.messages?.length) return copyMessages(input.messages)
    if (input.text) return [{ role: 'user', content: input.text }]
    return []
  }

  private _extendMessages(
    messages: readonly ModelMessage[],
    completion: LLMCompletion,
    toolResults: readonly ToolResult[],
  ): ModelMessage[] {
    const next = copyMessages(messages)
    const assistant: ModelMessage = {
      role: 'assistant',
      content: completion.content ?? '',
    }
    const toolCalls = completion.toolCalls ?? []
    if (toolCalls.length) {
      assistant.tool_calls = toolCalls.map(call => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      }))
    }
    next.push(assistant)

    for (const call of toolCalls) {
      const result = toolResults.find(candidate => candidate.callId === call.id)
      const content = result
        ? result.ok
          ? stringify(result.output)
          : `error: ${result.error?.message ?? 'unknown'}`
        : 'error: missing tool result'
      const message: ModelMessage = {
        role: 'tool',
        content,
        tool_call_id: call.id,
      }
      message.name = result?.name ?? call.name
      next.push(message)
    }
    return next
  }

  private _session(): SessionLog {
    const session = (this.ctx as unknown as { session?: SessionLog }).session
    if (!session) throw new AgentError('session service is required')
    return session
  }

  private _tools(): ToolsService {
    const tools = (this.ctx as unknown as { tools?: ToolsService }).tools
    if (!tools) throw new AgentError('tools service is required')
    return tools
  }

  private _llm(): LLMAdapter | undefined {
    return this.config.llm
  }
}

function copySteps(steps: readonly AgentStep[]): readonly AgentStep[] {
  return steps.map(step => ({
    index: step.index,
    input: copyMessages(step.input),
    completion: copyCompletion(step.completion),
    toolResults: step.toolResults.map(result => ({ ...result })),
  }))
}

export const agent = {
  name: 'agent',
  inject: ['session', 'tools'],
  apply: (ctx: Context, config: AgentConfig = {}) => {
    const service = new AgentService(ctx, config)
    ctx.provide('agent', service)
    ctx.provide('agentLoop', (input?: AgentInput, options?: AgentRunOptions) => service.run(input, options))
    ctx.provide('inbox', service.inbox)
    return () => {}
  },
}

export const name = '@tnega/agent'
