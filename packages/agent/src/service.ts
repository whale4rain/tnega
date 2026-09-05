import type { Context } from '@tnega/core'
import { randomUUID } from 'node:crypto'

import {
  DEFAULT_CONTEXT_LIMIT,
  estimateContextUsage,
  type ModelMessage,
  type RequestContextPayload,
  type SessionLog,
  type ToolResultPayload,
} from '@tnega/session'
import type { ToolDefinition, ToolError, ToolResult } from '@tnega/tools'
import type { ToolSchemaSnapshot } from './prompt.js'
import type { ToolsService } from '@tnega/tools'

import type {
  AgentContextBudget,
  AgentCancelCause,
  AgentFinishReason,
  AgentHooks,
  AgentInput,
  AgentPreStepEvent,
  AgentRequestErrorEvent,
  AgentRequestEvent,
  AgentRequestRetryDecision,
  AgentRunOptions,
  AgentRunResult,
  AgentStep,
  AgentStreamEvent,
  LLMStreamRequestEvent,
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
  private _steerQueue: AgentInput[] = []
  private _injected = new Map<string, unknown>()

  get size(): number {
    return this._queue.length + this._steerQueue.length
  }

  get steerSize(): number {
    return this._steerQueue.length
  }

  push(input: AgentInput): AgentInput {
    this._queue.push(input)
    return input
  }

  followup(input: AgentInput): AgentInput {
    return this.push(input)
  }

  steer(input: AgentInput): AgentInput {
    this._steerQueue.push(input)
    return input
  }

  send(
    input: AgentInput,
    options: { mode?: 'followup' | 'steer'; wake?: boolean } = {},
  ): AgentInput {
    if (options.mode === 'steer') return this.steer(input)
    return this.followup(input)
  }

  claim(): AgentInput | undefined {
    return this._steerQueue.shift() ?? this._queue.shift()
  }

  peek(): AgentInput | undefined {
    return this._steerQueue[0] ?? this._queue[0]
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
  /** Bind the loop to a specific session instead of the ctx-provided singleton. */
  session?: SessionLog
  /** Fail fast when the actual request would not be reconstructable from the log. */
  assertReplayable?: boolean
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

function isCancelCause(value: unknown): value is AgentCancelCause {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.type === 'user') return true
  if (
    record.type === 'abort'
    && (record.message === undefined || typeof record.message === 'string')
  ) {
    return true
  }
  if (record.type === 'timeout' && typeof record.timeoutMs === 'number') {
    return true
  }
  return false
}

function cancelCauseFromSignal(signal?: AbortSignal): AgentCancelCause | undefined {
  if (!signal?.aborted) return undefined
  const reason = signal.reason
  if (isCancelCause(reason)) return reason
  return { type: 'abort' }
}

function partialStreamContent(events: readonly LLMStreamEvent[]): string {
  let content = ''
  for (const event of events) {
    if (event.type === 'message_delta') content += event.delta
  }
  return content
}

async function cancellableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return !signal?.aborted
  if (signal?.aborted) return false
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class AgentService {
  readonly inbox: AgentInbox
  private _seriesStarted = false
  private _persistedRequest = false

  constructor(
    private ctx: Context,
    private config: AgentConfig = {},
  ) {
    this.inbox = config.inbox ?? new AgentInbox()
  }

  /** Call when a request begins an explicit new model-message series. */
  startSeries(): void {
    this._seriesStarted = true
  }

  /** Clear any pending series marker after a completed run. */
  endSeriesBoundary(): void {
    this._seriesStarted = false
  }

  /** True when this service instance has already persisted a model-visible step. */
  get hasPersistedRequest(): boolean {
    return this._persistedRequest
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

    let messages = await this._initialMessages(claimed)
    const steps: AgentStep[] = []
    let output = ''
    let finishReason: AgentFinishReason = 'stop'

    this.ctx.emit('agent/turn-start', {
      input: claimed,
      messages: copyMessages(messages),
      injected,
    })

    const turn = await session.nextTurn()
    await session.append('turn/start', {
      turn,
      input: claimed.text ?? claimed,
      reason: 'user',
    })

    let index = 0
    let finalTurnGranted = false
    let currentStepIndex: number | undefined
    let turnError: unknown
    try {
      while (index < maxTurns + (finalTurnGranted ? 1 : 0)) {
      if (options.signal?.aborted) {
        finishReason = 'cancelled'
        break
      }
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

      await session.append('step/start', { turn, step: index })
      currentStepIndex = index

      const requestedInput = copyMessages(preStep.messages)
      this.ctx.emit('agent/step', { index, input: copyMessages(requestedInput) })
      const availableTools = finalTurnGranted ? [] : await this._resolveAvailableTools()
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
      if (!request || !request.options || !request.tools) {
        throw new AgentError('agent/request must return a request payload')
      }
      let llmMessages = copyMessages(requestedInput)

      let completion: LLMCompletion | undefined
      const streamMethod = useStream ? llm.stream : undefined
      let attempt = 0
      let persistedStepInput = false
      while (true) {
        if (options.signal?.aborted) {
          finishReason = 'cancelled'
          break
        }
        const streamEvents: LLMStreamEvent[] = []
        try {
          if (streamMethod) {
            const streamRequest: LLMStreamRequestEvent = {
              index,
              messages: llmMessages,
              tools: request.tools,
              options: request.options,
            }
            const stream = await this.ctx.waterfallAsync(
              'llm/stream',
              streamRequest,
              async (payload: LLMStreamRequestEvent) => {
                if (!streamMethod) {
                  throw new AgentError('llm.stream is required for streaming runs')
                }
                return streamMethod(payload.messages, payload.tools, payload.options)
              },
            )
            if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
              throw new AgentError('llm/stream must return an async iterable stream')
            }
            llmMessages = copyMessages(streamRequest.messages)
            if (!persistedStepInput) {
              await this._persistStepInput(session, request, llmMessages)
              if (this.config.assertReplayable) {
                await this._assertReplayable(session, llmMessages)
              }
              persistedStepInput = true
            }
            let chunkIndex = 0
            for await (const event of stream) {
              streamEvents.push(event)
              if (event.type === 'message_delta') {
                await session.append('assistant/chunk', {
                  id: event.id,
                  content: event.delta,
                  index: chunkIndex,
                })
                chunkIndex += 1
              }
              yield event
            }
            completion = completionFromStreamEvents(streamEvents)
          } else {
            if (!persistedStepInput) {
              await this._persistStepInput(session, request, llmMessages)
              if (this.config.assertReplayable) {
                await this._assertReplayable(session, llmMessages)
              }
              persistedStepInput = true
            }
            completion = await llm.complete(llmMessages, request.tools, request.options)
          }
          break
        } catch (error) {
          const content = partialStreamContent(streamEvents)
          if (content) {
            await session.append('assistant/message', {
              content,
              interrupted: true,
            })
            llmMessages = await session.deriveMessages()
          }
          if (options.signal?.aborted) {
            finishReason = 'cancelled'
            break
          }
          attempt += 1
          const failure = toToolError(error)
          const decision = await this.ctx.waterfallAsync(
            'agent/request-error',
            {
              index,
              turn,
              step: index,
              messages: copyMessages(llmMessages),
              tools: request.tools,
              options: request.options,
              attempt,
              error,
              failure,
              ...(request.options.provider ? { provider: request.options.provider } : {}),
              ...(request.options.model ? { model: request.options.model } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            } satisfies AgentRequestErrorEvent,
            () => undefined,
          ) as AgentRequestRetryDecision
          if (options.signal?.aborted) {
            finishReason = 'cancelled'
            break
          }
          if (decision?.kind !== 'retry') throw error
          const retryId = randomUUID()
          const delayMs = decision.delayMs ?? 0
          await session.append('llm/retry', {
            retryId,
            retry: attempt,
            ...(delayMs > 0 ? { delayMs } : {}),
            failure: toToolError(error),
          })
          if (!await cancellableDelay(delayMs, options.signal)) {
            finishReason = 'cancelled'
            break
          }
          await session.append('llm/retry-started', { retryId, retry: attempt })
        }
      }
      if (options.signal?.aborted) break
      if (!completion) throw new AgentError('LLM adapter did not produce a completion')

      const toolCalls = completion.toolCalls ?? []
      if (finalTurnGranted && toolCalls.length) {
        finishReason = 'max_turns'
        break
      }
      const toolResults: ToolResult[] = []
      if (toolCalls.length) {
        await session.append('assistant/message', {
          content: completion.content ?? '',
        })
      }
      for (const call of toolCalls) {
        this.ctx.emit('agent/tool-call', { index, call })
        yield { type: 'tool/start', index, call }
        await session.append('tool/call', {
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
        await session.append('tool/result', toolResultPayload)
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
        await session.append('assistant/message', { content: completion.content ?? '' })
      }

      await session.append('step/end', {
        turn,
        step: index,
        finishReason: completion.finishReason,
        toolCalls: toolCalls.length,
      })
      currentStepIndex = undefined

      const nextMessages = this._extendMessages(llmMessages, completion, toolResults)
      const concludesTurn = toolResults.some(result => result.concludesTurn === true)
      if (concludesTurn) {
        finishReason = 'stop'
        break
      }
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
      const cancelCause = cancelCauseFromSignal(options.signal)
      if (currentStepIndex !== undefined) {
        const cancelled = options.signal?.aborted
        await session.append('step/end', {
          turn,
          step: currentStepIndex,
          finishReason: cancelled
            ? 'cancelled'
            : turnError
              ? 'error'
              : 'interrupted',
          interrupted: true,
          ...(cancelCause ? { cancelCause } : {}),
          ...(turnError ? { error: toToolError(turnError) } : {}),
        })
      }
      await session.append('turn/end', {
        turn,
        finishReason: turnError
          ? (options.signal?.aborted ? 'cancelled' : 'error')
          : finishReason,
        ...(cancelCause ? { cancelCause } : {}),
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
    request: AgentRequestEvent,
    input: readonly ModelMessage[],
  ): Promise<void> {
    const system = input.find(message => message.role === 'system')?.content
    const tools = request.tools.map(tool => ({
      name: tool.schema.name,
      description: tool.schema.description,
      ...(tool.schema.parameters ? { parameters: tool.schema.parameters } : {}),
    }))
    const config = {
      ...(request.options.provider ? { provider: request.options.provider } : {}),
      ...(request.options.model ? { model: request.options.model } : {}),
      ...(request.options.temperature !== undefined
        ? { temperature: request.options.temperature }
        : {}),
    }
    const nextHeader = {
      ...(Object.keys(config).length ? { config } : {}),
      ...(system !== undefined ? { system } : {}),
      ...(tools.length ? { tools } : {}),
    }
    const previousHeader = session.requestHeader()
    const isFirstRequest = !this._persistedRequest
    const isResume = isFirstRequest && previousHeader !== undefined
    this._persistedRequest = true
    const changedHeader = previousHeader && (
      previousHeader.system !== nextHeader.system
      || JSON.stringify(previousHeader.tools ?? []) !== JSON.stringify(nextHeader.tools ?? [])
      || JSON.stringify(previousHeader.config ?? {}) !== JSON.stringify(nextHeader.config ?? {})
    )
    if (isFirstRequest) {
      await session.append('request/header', {
        reason: this._seriesStarted
          ? 'series'
          : isResume
            ? 'resume'
            : 'initial',
        ...nextHeader,
        ...(this._seriesStarted ? { startsSeries: true } : {}),
      })
    } else if (changedHeader) {
      await session.append('request/header', {
        reason: this._seriesStarted ? 'change-series' : 'change',
        ...nextHeader,
        startsSeries: true,
      })
    } else if (this._seriesStarted) {
      await session.append('request/header', {
        reason: 'series',
        ...nextHeader,
        startsSeries: true,
      })
    }
    this._seriesStarted = false

    const nextContext: RequestContextPayload = {
      ...(request.options.provider ? { provider: request.options.provider } : {}),
      ...(request.options.model ? { model: request.options.model } : {}),
    }
    const llmService = this.ctx.reflect.get('llm', false) as
      | { routeCapacity(): unknown }
      | undefined
    const routeCapacity = llmService?.routeCapacity?.() as
      | { provider?: string; model?: string; contextWindow?: number }
      | undefined
    if (routeCapacity?.contextWindow !== undefined) {
      nextContext.contextWindow = routeCapacity.contextWindow
    }
    const previousContext = session.requestContext()
    if (
      previousContext?.provider !== nextContext.provider
      || previousContext?.model !== nextContext.model
      || previousContext?.contextWindow !== nextContext.contextWindow
      || (previousContext === undefined)
    ) {
      await session.append('request/context', nextContext)
    }
    const requested = input.filter(isUserOrSystemMessage)
    const surface = (await session.deriveMessages()).filter(isUserOrSystemMessage)
    // The session surface is the durable history. A caller may include the full
    // derived history as model context; only the tail that is not already in
    // the surface is new. Text-based prefix/suffix matching is unsafe because
    // the same user text can legitimately repeat across turns, so append by
    // count and only when the requested sequence is actually longer.
    const known = Math.min(surface.length, requested.length)
    const newCount = requested.length - known
    for (const message of requested.slice(requested.length - Math.max(0, newCount))) {
      if (message.role === 'user') {
        await session.append('user/message', {
          content: message.content,
          ...(message.name ? { name: message.name } : {}),
        })
      } else {
        await session.append('system/message', {
          content: message.content,
          ...(message.name ? { name: message.name } : {}),
        })
      }
    }
  }

  private async _assertReplayable(
    session: SessionLog,
    input: readonly ModelMessage[],
  ): Promise<void> {
    const reconstructed = await session.deriveMessages()
    const canonical = (messages: readonly ModelMessage[]) => messages
      .filter(message => message.role !== 'system')
      .map(message => ({
        role: message.role,
        content: message.content,
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_calls?.length
          ? { tool_calls: message.tool_calls.map(call => ({
              id: call.id,
              name: call.name,
              args: JSON.stringify(call.arguments ?? {}),
            })) }
          : {}),
      }))
    const actual = canonical(input)
    const replay = canonical(reconstructed)
    if (JSON.stringify(actual) !== JSON.stringify(replay)) {
      throw new AgentError(
        `request is not reconstructable from session log: actual=${JSON.stringify(actual)} replay=${JSON.stringify(replay)}`,
      )
    }
  }

  private async _initialMessages(input: AgentInput): Promise<ModelMessage[]> {
    const promptService = this.ctx.reflect.get('systemPrompt', false) as
      | { assemble(options?: object): Promise<{ text: string }> }
      | undefined
    const assembled = promptService
      ? (await promptService.assemble()).text.trim()
      : undefined
    const systemPrompt = assembled || this.inbox.injected().get('agentSystem')
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
    if (this.config.session) return this.config.session
    const session = (this.ctx as unknown as { session?: SessionLog }).session
    if (!session) throw new AgentError('session service is required')
    return session
  }

  private _tools(): ToolsService {
    const tools = (this.ctx as unknown as { tools?: ToolsService }).tools
    if (!tools) throw new AgentError('tools service is required')
    return tools
  }

  private async _resolveAvailableTools(): Promise<readonly ToolDefinition[]> {
    const promptService = this.ctx.reflect.get('systemPrompt', false) as
      | { toolSchemas(options?: object): Promise<readonly ToolSchemaSnapshot[]> }
      | undefined
    if (promptService) {
      const schemas = await promptService.toolSchemas()
      return schemas.map(schema => ({
        schema,
        execute: async () => {
          throw new Error('schema-only tool from prompt assembly')
        },
      }))
    }
    return this._tools().list()
  }

  private _llm(): LLMAdapter | undefined {
    if (this.config.llm) return this.config.llm
    const service = this.ctx.reflect.get('llm', false) as
      | { current(): LLMAdapter | undefined }
      | undefined
    return service?.current()
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
