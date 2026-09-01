import type { Context } from '@tnega/core'
import {
  DEFAULT_CONTEXT_LIMIT,
  estimateContextUsage,
  type ModelMessage,
  type SessionLog,
  type ToolResultPayload,
} from '@tnega/session'
import type { ToolError, ToolResult } from '@tnega/tools'
import type { ToolsService } from '@tnega/tools'

import type {
  AgentContextBudget,
  AgentFinishReason,
  AgentHooks,
  AgentInput,
  AgentPreStepEvent,
  AgentRequestEvent,
  AgentRunOptions,
  AgentRunResult,
  AgentStep,
  AgentStreamEvent,
  AgentTurnStoppingEvent,
  CompleteOptions,
  LLMAdapter,
  LLMCompletion,
  LLMStreamEvent,
  LLMToolCall,
} from './types.js'

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

export interface AgentConfig {
  llm?: LLMAdapter
  maxTurns?: number
  maxSteps?: number
  inbox?: AgentInbox
  hooks?: AgentHooks
  contextBudget?: AgentContextBudget
}

function copyMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    const copy: ModelMessage = {
      role: message.role,
      content: message.content,
    }
    if (message.name) copy.name = message.name
    if (message.tool_call_id) copy.tool_call_id = message.tool_call_id
    if (message.toolOk !== undefined) copy.toolOk = message.toolOk
    if (message.toolError) copy.toolError = { ...message.toolError }
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

function isUserOrSystemMessage(
  message: ModelMessage,
): message is ModelMessage & { role: 'system' | 'user' } {
  return message.role === 'system' || message.role === 'user'
}

function sameSurfaceMessage(left: ModelMessage, right: ModelMessage): boolean {
  return left.role === right.role
    && left.content === right.content
    && (left.name ?? '') === (right.name ?? '')
}

function commonSurfacePrefix(
  left: readonly ModelMessage[],
  right: readonly ModelMessage[],
): number {
  const max = Math.min(left.length, right.length)
  let count = 0
  while (count < max && sameSurfaceMessage(left[count]!, right[count]!)) count += 1
  return count
}

function commonSurfaceSuffix(
  left: readonly ModelMessage[],
  right: readonly ModelMessage[],
): number {
  const max = Math.min(left.length, right.length)
  let count = 0
  while (
    count < max
    && sameSurfaceMessage(left[left.length - 1 - count]!, right[right.length - 1 - count]!)
  ) {
    count += 1
  }
  return count
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
    return consumeAgentStream(this._stream(input, options, false))
  }

  async *runStream(
    input?: AgentInput,
    options: AgentRunOptions = {},
  ): AsyncGenerator<AgentStreamEvent, AgentRunResult, void> {
    const iterator = this._stream(input, options)[Symbol.asyncIterator]()
    while (true) {
      const next = await iterator.next()
      if (next.done) return next.value
      yield next.value
    }
  }

  private async *_stream(
    input?: AgentInput,
    options: AgentRunOptions = {},
    useStream = true,
  ): AsyncGenerator<AgentStreamEvent, AgentRunResult, void> {
    const claimed = input ?? this.inbox.claim()
    if (!claimed) throw new AgentError('no agent input available')
    await this.config.hooks?.beforeRun?.(claimed, options)

    const session = this._session()
    const tools = this._tools()
    const llm = this._llm()
    if (!llm) throw new AgentError('no LLM adapter available')

    const maxTurns = options.maxTurns ?? this.config.maxTurns ?? 64
    const maxSteps = options.maxSteps ?? this.config.maxSteps ?? 64
    const contextBudget = options.contextBudget ?? this.config.contextBudget
    const injected = this.inbox.injected()
    this.ctx.emit('agent/start', { input: claimed, options, injected })

    let messages = this._initialMessages(claimed)
    const steps: AgentStep[] = []
    let output = ''
    let finishReason: AgentFinishReason = 'stop'

    this.ctx.emit('agent/turn-start', {
      input: claimed,
      messages: copyMessages(messages),
      injected,
    })

    await session.append('turn/start', {
      input: claimed.text ?? claimed,
      reason: 'user',
    })

    let index = 0
    let finalTurnGranted = false
    let currentStepIndex: number | undefined
    let turnError: unknown
    try {
      while (index < maxTurns + (finalTurnGranted ? 1 : 0)) {
      if (steps.length >= maxSteps) {
        finishReason = 'max_steps'
        break
      }
      if (contextBudget) {
        messages = await this._enforceContextBudget(session, contextBudget, messages)
      }

      const stepInput = copyMessages(messages)
      const preStep = this.ctx.waterfall('agent/pre-step', {
        index,
        messages: stepInput,
      }, (payload: AgentPreStepEvent) => payload)
      if (!preStep || !Array.isArray(preStep.messages) || !preStep.messages.length) {
        break
      }

      await session.append('step/start', { index })
      currentStepIndex = index

      const requestedInput = copyMessages(preStep.messages)
      this.ctx.emit('agent/step', { index, input: copyMessages(requestedInput) })
      const availableTools = finalTurnGranted ? [] : tools.list()
      const completeOptions: CompleteOptions = {
        maxSteps: maxSteps - steps.length,
      }
      if (options.signal) completeOptions.signal = options.signal

      const request = this.ctx.waterfall('agent/request', {
        index,
        messages: requestedInput,
        tools: availableTools,
        options: completeOptions,
      }, (payload: AgentRequestEvent) => payload)
      if (!request || !Array.isArray(request.messages)) {
        throw new AgentError('agent/request must return a request payload')
      }
      const llmMessages = copyMessages(request.messages)
      await this._persistStepInput(session, llmMessages)

      let completion: LLMCompletion
      const streamMethod = useStream ? llm.stream : undefined
      if (streamMethod) {
        const streamEvents: LLMStreamEvent[] = []
        let cancelled = false
        try {
          for await (const event of streamMethod(llmMessages, request.tools, request.options)) {
            streamEvents.push(event)
            yield event
          }
        } catch (error) {
          if (!options.signal?.aborted) throw error
          finishReason = 'cancelled'
          cancelled = true
        }
        if (cancelled) break
        completion = completionFromStreamEvents(streamEvents)
      } else {
        try {
          completion = await llm.complete(llmMessages, request.tools, request.options)
        } catch (error) {
          if (!options.signal?.aborted) throw error
          finishReason = 'cancelled'
          break
        }
      }

      const toolCalls = completion.toolCalls ?? []
      if (finalTurnGranted && toolCalls.length) {
        finishReason = 'max_turns'
        break
      }
      const toolResults: ToolResult[] = []
      if (toolCalls.length) {
        await session.append('message', {
          role: 'assistant',
          content: completion.content ?? '',
        })
      }
      for (const call of toolCalls) {
        this.ctx.emit('agent/tool-call', { index, call })
        yield { type: 'tool/start', index, call }
        await session.append('tool-call', {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })
        const toolOptions: { callId: string; signal?: AbortSignal } = { callId: call.id }
        if (options.signal) toolOptions.signal = options.signal
        const startedAt = Date.now()
        let result: ToolResult
        try {
          result = await tools.execute(call.name, call.arguments, toolOptions)
        } catch (error) {
          result = {
            ok: false,
            name: call.name,
            callId: call.id,
            input: call.arguments,
            error: toToolError(error),
            startedAt,
            durationMs: Date.now() - startedAt,
          }
        }
        toolResults.push(result)
        const toolResultPayload: ToolResultPayload = {
          id: call.id,
          toolCallId: call.id,
          name: call.name,
          ok: result.ok,
          durationMs: result.durationMs,
        }
        if (result.output !== undefined) toolResultPayload.output = result.output
        if (result.error) {
          toolResultPayload.error = {
            name: result.error.name,
            message: result.error.message,
          }
          if (result.error.stack) toolResultPayload.error.stack = result.error.stack
        }
        await session.append('tool-result', toolResultPayload)
        yield { type: 'tool/end', index, call, result }
        this.ctx.emit('agent/tool-result', { index, call, result })
      }
      if (options.signal?.aborted) {
        finishReason = 'cancelled'
        break
      }

      steps.push({
        index,
        input: copyMessages(llmMessages),
        completion,
        toolResults,
      })

      if (completion.content) {
        output = completion.content
      }
      if (!toolCalls.length) {
        await session.append('message', { role: 'assistant', content: completion.content ?? '' })
      }

      await session.append('step/end', {
        index,
        finishReason: completion.finishReason,
        toolCalls: toolCalls.length,
      })
      currentStepIndex = undefined

      const nextMessages = this._extendMessages(llmMessages, completion, toolResults)
      if (toolCalls.length === 0) {
        finishReason = completion.finishReason === 'length'
          ? 'length'
          : completion.finishReason === 'error'
            ? 'error'
            : 'stop'
        const keepGoing = await this.ctx.serial('agent/turn-stopping', {
          index,
          steps: copySteps(steps),
          finishReason,
        } satisfies AgentTurnStoppingEvent) as unknown
        if (!keepGoing) break
      }
      if (index + 1 >= maxTurns && !finalTurnGranted) {
        finalTurnGranted = true
      } else if (index + 1 >= maxTurns + (finalTurnGranted ? 1 : 0)) {
        finishReason = 'max_turns'
        break
      }
      if (toolCalls.length) finishReason = 'tool_calls'
      index += 1
      messages = nextMessages
    }
    } catch (error) {
      turnError = error
      throw error
    } finally {
      if (currentStepIndex !== undefined) {
        const cancelled = options.signal?.aborted
        await session.append('step/end', {
          index: currentStepIndex,
          finishReason: cancelled
            ? 'cancelled'
            : turnError
              ? 'error'
              : 'interrupted',
          interrupted: true,
          ...(turnError ? { error: toToolError(turnError) } : {}),
        })
      }
      await session.append('turn/end', {
        finishReason: turnError
          ? (options.signal?.aborted ? 'cancelled' : 'error')
          : finishReason,
        ...(output ? { output } : {}),
        ...(steps.length ? { steps: steps.length } : {}),
        ...(turnError ? { interrupted: true, error: toToolError(turnError) } : {}),
      })
    }

    const runResult: AgentRunResult = {
      input: claimed,
      output,
      finishReason,
      steps,
      messages: copyMessages(messages),
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
    await this.config.hooks?.afterRun?.(runResult, options)

    yield { type: 'run/end', run: runResult }
    return runResult
  }

  private async _enforceContextBudget(
    session: SessionLog,
    budget: AgentContextBudget,
    messages: readonly ModelMessage[],
  ): Promise<ModelMessage[]> {
    const limit = budget.limit ?? DEFAULT_CONTEXT_LIMIT
    const compactRatio = budget.compactRatio ?? 0.9
    if (limit <= 0 || compactRatio <= 0 || compactRatio > 1) {
      throw new AgentError('invalid context budget: limit must be positive and compactRatio must be in (0, 1]')
    }
    const usage = estimateContextUsage(messages, limit)
    if (usage.ratio < compactRatio) return copyMessages(messages)
    const keepTokens = budget.keepTokens ?? Math.max(1, Math.floor(limit * 0.5))
    const compactMessages = budget.summarize
      ? await budget.summarize(messages, usage)
      : [{ role: 'system' as const, content: defaultContextSummary(messages, usage) }]
    const summary = compactMessages
      .map(message => `${message.role}: ${message.content}`)
      .join('\n')
    await session.compact({
      keepTokens,
      summary,
      tokensBefore: usage.tokens,
      messages: compactMessages.map(message => copyMessages([message])[0]!),
    })
    this.ctx.emit('agent/context-compact', {
      type: 'agent/context-compact',
      messagesBefore: messages.length,
      tokensBefore: usage.tokens,
      limit,
      keepTokens,
      messagesAfter: compactMessages.length,
    })
    return compactMessages.map(message => copyMessages([message])[0]!)
  }

  private async _persistStepInput(
    session: SessionLog,
    input: readonly ModelMessage[],
  ): Promise<void> {
    const requested = input.filter(isUserOrSystemMessage)
    const surface = (await session.deriveMessages()).filter(isUserOrSystemMessage)
    const prefix = commonSurfacePrefix(requested, surface)
    const suffix = commonSurfaceSuffix(requested.slice(prefix), surface.slice(prefix))
    for (const message of requested.slice(prefix, requested.length - suffix)) {
      await session.append('message', {
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
      })
    }
  }

  private _initialMessages(input: AgentInput): ModelMessage[] {
    const systemPrompt = this.inbox.injected().get('agentSystem')
    const systemMessage = typeof systemPrompt === 'string' && systemPrompt
      ? [{ role: 'system' as const, content: systemPrompt }]
      : []
    if (input.messages?.length) {
      const first = input.messages[0]
      if (first?.role === 'system') return copyMessages(input.messages)
      return [...systemMessage, ...copyMessages(input.messages)]
    }
    if (input.text) return [...systemMessage, { role: 'user', content: input.text }]
    return systemMessage
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
      if (result && !result.ok) {
        message.toolOk = false
        if (result.error) {
          message.toolError = {
            name: result.error.name,
            message: result.error.message,
          }
        }
      }
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

function defaultContextSummary(
  messages: readonly ModelMessage[],
  usage: { tokens: number },
): string {
  const latest = messages.at(-1)
  const latestText = latest ? `${latest.role}: ${latest.content}` : 'none'
  return [
    'Earlier context was compacted.',
    `Messages before compaction: ${messages.length}.`,
    `Tokens before compaction: ${usage.tokens}.`,
    `Latest message: ${latestText}`,
  ].join(' ')
}

function copySteps(steps: readonly AgentStep[]): readonly AgentStep[] {
  return steps.map(step => ({
    index: step.index,
    input: copyMessages(step.input),
    completion: copyCompletion(step.completion),
    toolResults: step.toolResults.map(result => ({ ...result })),
  }))
}

function toToolError(error: unknown): ToolError {
  if (error instanceof Error) {
    const result: ToolError = {
      name: error.name,
      message: error.message,
    }
    if (error.stack) result.stack = error.stack
    return result
  }
  return {
    name: 'ToolExecutionError',
    message: String(error),
  }
}

function completionFromStreamEvents(events: readonly LLMStreamEvent[]): LLMCompletion {
  let content = ''
  const calls = new Map<number, LLMToolCall>()
  let finishReason: AgentFinishReason = 'error'
  for (const event of events) {
    if (event.type === 'message_delta') {
      content += event.delta
    } else if (event.type === 'toolcall_end') {
      calls.set(event.index, {
        id: event.id,
        name: event.name,
        arguments: event.arguments,
      })
    } else if (event.type === 'message_stop') {
      finishReason = event.finishReason
    }
  }
  const completion: LLMCompletion = { finishReason }
  if (content) completion.content = content
  if (calls.size) completion.toolCalls = [...calls.values()]
  return completion
}

async function consumeAgentStream(
  stream: AsyncGenerator<AgentStreamEvent, AgentRunResult, void>,
): Promise<AgentRunResult> {
  const iterator = stream[Symbol.asyncIterator]()
  while (true) {
    const next = await iterator.next()
    if (next.done) return next.value
  }
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
