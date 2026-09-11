import type { Context } from '@tnega/core'
import { randomUUID } from 'node:crypto'

import {
  DEFAULT_CONTEXT_LIMIT,
  estimateContextUsage,
  type ModelMessage,
  type RequestContextPayload,
  type SessionLog,
  type ToolResultPayload,
  type TurnEndReason,
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
  AgentNextStepClaimer,
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
  /** Compatibility diagnostic flag; request replayability is always enforced. */
  assertReplayable?: boolean
  maxTurns?: number
  maxSteps?: number
  inbox?: AgentInbox
  hooks?: AgentHooks
  contextBudget?: AgentContextBudget
  /** Optional live-agent seam for work admitted after the first step. */
  claimNextStep?: AgentNextStepClaimer
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
        arguments: structuredClone(call.arguments),
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

function canonicalMessages(messages: readonly ModelMessage[]): string {
  return JSON.stringify(messages.map(message => ({
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    ...(message.toolOk !== undefined ? { toolOk: message.toolOk } : {}),
    ...(message.toolError ? {
      toolError: { name: message.toolError.name, message: message.toolError.message },
    } : {}),
  })))
}

function freezeRequestData(data: unknown): void {
  const visited = new Set<object>()
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || visited.has(value)) return
    visited.add(value)
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(data)
}

function lockStreamRequest(request: LLMStreamRequestEvent): void {
  freezeRequestData(request.messages)
  request.tools = Object.freeze(request.tools.map(tool => {
    // Tool definitions belong to the registry. Lock a request-local schema
    // snapshot so later requests can still update the registered definition.
    const schema = structuredClone(tool.schema)
    freezeRequestData(schema)
    return Object.freeze({ ...tool, schema })
  }))
  // The signal remains live; only the request's option bindings are locked.
  Object.freeze(request.options)
  Object.freeze(request)
}

function requestHeaderFor(
  request: Pick<AgentRequestEvent, 'tools' | 'options'>,
  input: readonly ModelMessage[],
): {
  config?: { provider?: string; model?: string; temperature?: number }
  system?: string
  tools?: ToolSchemaSnapshot[]
} {
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
  return {
    ...(Object.keys(config).length ? { config } : {}),
    ...(system !== undefined ? { system } : {}),
    ...(tools.length ? { tools } : {}),
  }
}

async function* completeAsStream(
  llm: LLMAdapter,
  messages: readonly ModelMessage[],
  tools: readonly ToolDefinition[],
  options: CompleteOptions,
): AsyncGenerator<LLMStreamEvent, void, void> {
  const id = randomUUID()
  yield { type: 'message_start', id }
  const completion = await llm.complete(messages, tools, options)
  if (completion.content) yield { type: 'message_delta', id, delta: completion.content }
  for (let index = 0; index < (completion.toolCalls?.length ?? 0); index += 1) {
    const call = completion.toolCalls![index]!
    yield { type: 'toolcall_start', id: call.id, index, name: call.name }
    yield {
      type: 'toolcall_end',
      id: call.id,
      index,
      name: call.name,
      arguments: call.arguments,
    }
  }
  yield { type: 'message_stop', id, finishReason: completion.finishReason }
}

function isCancelCause(value: unknown): value is AgentCancelCause {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.type === 'user' || record.type === 'parent' || record.type === 'disposed') {
    return true
  }
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

function abortedToolError(signal?: AbortSignal): ToolError {
  const cause = cancelCauseFromSignal(signal)
  return {
    name: 'AbortError',
    message: `tool call aborted: ${cause?.type ?? 'abort'}`,
  }
}

/** Map a completed loop to the typed durable reason a `turn/end` records. */
function toTurnEndReason(fields: {
  cancelled: boolean
  turnError: unknown
  finishReason: AgentFinishReason
  cancelCause?: AgentCancelCause
}): TurnEndReason {
  const { cancelled, turnError, finishReason, cancelCause } = fields
  if (cancelled || finishReason === 'cancelled') {
    return { kind: 'aborted', cause: cancelCause ?? { type: 'user' } }
  }
  if (turnError || finishReason === 'error') {
    return {
      kind: 'error',
      error: turnError
        ? toToolError(turnError)
        : { name: 'TurnError', message: finishReason },
    }
  }
  switch (finishReason) {
    case 'length':
      return { kind: 'max-tokens' }
    case 'max_steps':
      return { kind: 'max-steps' }
    case 'max_turns':
      return { kind: 'max-turns' }
    default:
      return { kind: 'completed' }
  }
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
    return consumeAgentStream(this._stream(input, options))
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
  ): AsyncGenerator<AgentStreamEvent, AgentRunResult, void> {
    const claimed = input ?? this.inbox.claim()
    if (!claimed) throw new AgentError('no agent input available')
    await this.config.hooks?.beforeRun?.(claimed, options)

    const session = this._session()
    const tools = this._tools()
    const llm = this._llm()
    if (!llm) throw new AgentError('no LLM adapter available')
    const streamAdapter = llm.stream
    const persistChunks = streamAdapter !== undefined

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
        turn,
        step: index,
        messages: stepInput,
        ...(options.signal ? { signal: options.signal } : {}),
      }, (payload: AgentPreStepEvent) => payload)
      if (!preStep || !Array.isArray(preStep.messages) || !preStep.messages.length) {
        break
      }
      if (preStep.startsRequestSeries) this._seriesStarted = true

      await session.append('step/start', { turn, step: index })
      currentStepIndex = index

      const requestedInput = copyMessages(preStep.messages)
      // Request rewrites may replace the current surface, but retries retain
      // the durable owners present when this step was admitted.
      const admittedHistory = await session.deriveMessages()
      this.ctx.emit('agent/step', {
        index,
        turn,
        step: index,
        input: copyMessages(requestedInput),
      })
      const availableTools = finalTurnGranted ? [] : await this._resolveAvailableTools()
      const completeOptions: CompleteOptions = {
        maxSteps: maxSteps - steps.length,
      }
      if (options.signal) completeOptions.signal = options.signal

      let llmMessages = copyMessages(requestedInput)

      let completion: LLMCompletion | undefined
      let attempt = 0
      while (true) {
        if (options.signal?.aborted) {
          finishReason = 'cancelled'
          break
        }
        const streamEvents: LLMStreamEvent[] = []
        const streamRequest: LLMStreamRequestEvent = {
          index,
          messages: copyMessages(requestedInput),
          tools: [...availableTools],
          options: { ...completeOptions },
        }
        try {
          const request = this.ctx.waterfall('agent/request', {
            index,
            messages: copyMessages(requestedInput),
            tools: streamRequest.tools,
            options: streamRequest.options,
          }, (payload: AgentRequestEvent) => payload)
          if (!request || !request.options || !request.tools) {
            throw new AgentError('agent/request must return a request payload')
          }
          streamRequest.tools = request.tools
          streamRequest.options = request.options
          let preparation: Promise<void> | undefined
          const prepareRequest = (): Promise<void> => preparation ??= (async () => {
            // Waterfalls may rewrite the envelope until consumption begins.
            // Lazy streams must dispatch the same request that is persisted.
            lockStreamRequest(streamRequest)
            llmMessages = copyMessages(streamRequest.messages)
            await this._persistStepInput(session, streamRequest, llmMessages, admittedHistory)
            await this._assertReplayable(session, streamRequest, llmMessages)
          })()
          const stream = await this.ctx.waterfallAsync(
            'llm/stream',
            streamRequest,
            (payload: LLMStreamRequestEvent) => (async function* () {
              // A listener can consume next() itself. Guard that dispatch too.
              await prepareRequest()
              yield* streamAdapter
                ? streamAdapter.call(llm, payload.messages, payload.tools, payload.options)
                : completeAsStream(llm, payload.messages, payload.tools, payload.options)
            })(),
          )
          if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
            throw new AgentError('llm/stream must return an async iterable stream')
          }
          // Short-circuit streams must obey the same request invariant.
          await prepareRequest()
          let chunkIndex = 0
          for await (const event of stream) {
            streamEvents.push(event)
            if (persistChunks && event.type === 'message_delta') {
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
          break
        } catch (error) {
          if (options.signal?.aborted) {
            const content = partialStreamContent(streamEvents)
            if (content) {
              await session.append('assistant/message', { content, interrupted: true })
            }
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
              messages: copyMessages(streamRequest.messages),
              tools: [...streamRequest.tools],
              options: { ...streamRequest.options },
              attempt,
              error,
              failure,
              ...(streamRequest.options.provider ? { provider: streamRequest.options.provider } : {}),
              ...(streamRequest.options.model ? { model: streamRequest.options.model } : {}),
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
      if (!completion) {
        if (options.signal?.aborted) {
          finishReason = 'cancelled'
          break
        }
        throw new AgentError('LLM adapter did not produce a completion')
      }

      const toolCalls = completion.toolCalls ?? []
      if (options.signal?.aborted && toolCalls.length === 0) {
        finishReason = 'cancelled'
        break
      }
      if (finalTurnGranted && toolCalls.length && !options.signal?.aborted) {
        finishReason = 'max_turns'
        break
      }
      const toolResults: ToolResult[] = []
      if (toolCalls.length) {
        await session.append('assistant/message', {
          content: completion.content ?? '',
          toolCalls: toolCalls.map(call => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        })
      }
      for (const call of toolCalls) {
        this.ctx.emit('agent/tool-call', { index, turn, step: index, call })
        yield { type: 'tool/start', index, turn, step: index, call }
        await session.append('tool/call', {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })
        const toolOptions: { callId: string; signal?: AbortSignal } = { callId: call.id }
        if (options.signal) toolOptions.signal = options.signal
        const startedAt = Date.now()
        let result: ToolResult
        if (options.signal?.aborted) {
          result = {
            ok: false,
            name: call.name,
            callId: call.id,
            input: call.arguments,
            error: abortedToolError(options.signal),
            startedAt,
            durationMs: Date.now() - startedAt,
          }
        } else {
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
        yield { type: 'tool/end', index, turn, step: index, call, result }
        this.ctx.emit('agent/tool-result', {
          index,
          turn,
          step: index,
          call,
          result,
        })
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
      let nextStepMessages = await this._claimNextStepMessages()
      if (toolCalls.length === 0 && nextStepMessages.length === 0) {
        finishReason = completion.finishReason === 'length'
          ? 'length'
          : completion.finishReason === 'error'
            ? 'error'
            : 'stop'
        const keepGoing = await this.ctx.serial('agent/turn-stopping', {
          index,
          turn,
          steps: copySteps(steps),
          finishReason,
        } satisfies AgentTurnStoppingEvent) as unknown
        if (!keepGoing) {
          nextStepMessages = await this._claimNextStepMessages()
          if (nextStepMessages.length === 0) break
        }
      }
      if (index + 1 >= maxTurns && !finalTurnGranted) {
        finalTurnGranted = true
      } else if (index + 1 >= maxTurns + (finalTurnGranted ? 1 : 0)) {
        finishReason = 'max_turns'
        break
      }
      if (toolCalls.length) finishReason = 'tool_calls'
      index += 1
      messages = [...nextMessages, ...nextStepMessages]
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
        reason: toTurnEndReason({
          cancelled: options.signal?.aborted ?? false,
          turnError,
          finishReason: turnError
            ? (options.signal?.aborted ? 'cancelled' : 'error')
            : finishReason,
          ...(cancelCause ? { cancelCause } : {}),
        }),
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
      turn,
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
    request: Pick<AgentRequestEvent, 'tools' | 'options'>,
    input: readonly ModelMessage[],
    admittedHistory: readonly ModelMessage[],
  ): Promise<void> {
    const surface = await session.deriveMessages()
    const owned = admittedHistory.filter(message => !isUserOrSystemMessage(message))
    let ownerIndex = 0
    for (const message of input) {
      if (isUserOrSystemMessage(message)) continue
      const actual = canonicalMessages([message])
      while (ownerIndex < owned.length && canonicalMessages([owned[ownerIndex]!]) !== actual) {
        ownerIndex += 1
      }
      if (ownerIndex === owned.length) {
        throw new AgentError('request is not reconstructable from session log: unowned or reordered assistant/tool message')
      }
      ownerIndex += 1
    }
    const nextHeader = requestHeaderFor(request, input)
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
    const isSurfacePrefix = (messages: readonly ModelMessage[]): boolean =>
      canonicalMessages(messages.slice(0, surface.length)) === canonicalMessages(surface)
    // A run-scoped leading system may be owned by the effective header. Remove
    // exactly that prefix when the remaining transcript extends the surface.
    const requested = surface.length > 0
      && input[0]?.role === 'system'
      && input[0].content === nextHeader.system
      && isSurfacePrefix(input.slice(1))
      ? input.slice(1)
      : input
    const tail = requested.slice(surface.length)
    if (isSurfacePrefix(requested) && tail.every(isUserOrSystemMessage)) {
      for (const message of tail) {
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
      return
    }
    // Rewrites replace the model surface through the existing append-only
    // checkpoint operation. Prior raw history and its message owners remain.
    const nodes = await session.surfaceEvents()
    await session.append('checkpoint', {
      messages: copyMessages(requested),
      surfaceOp: { op: 'replace', start: nodes[0]!.seq, end: nodes.at(-1)!.seq },
    })
  }

  private async _assertReplayable(
    session: SessionLog,
    request: Pick<AgentRequestEvent, 'tools' | 'options'>,
    input: readonly ModelMessage[],
  ): Promise<void> {
    const reconstructed = await session.deriveMessages()
    const actual = canonicalMessages(input)
    const replay = canonicalMessages(reconstructed)
    const header = session.requestHeader()
    const headerOwnsPrefix = input[0]?.role === 'system'
      && input[0].content === header?.system
      && canonicalMessages(input.slice(1)) === replay
    if (actual !== replay && !headerOwnsPrefix) {
      throw new AgentError(
        `request is not reconstructable from session log: actual=${actual} replay=${replay}`,
      )
    }
    const expected = requestHeaderFor(request, input)
    if (
      header?.system !== expected.system
      || JSON.stringify(header?.tools ?? []) !== JSON.stringify(expected.tools ?? [])
      || JSON.stringify(header?.config ?? {}) !== JSON.stringify(expected.config ?? {})
    ) {
      throw new AgentError('request envelope is not reconstructable from session log')
    }
  }

  private async _claimNextStepMessages(): Promise<ModelMessage[]> {
    const inputs = await this.config.claimNextStep?.() ?? []
    return inputs.flatMap(input => input.messages?.length
      ? copyMessages(input.messages)
      : input.text
        ? [{ role: 'user' as const, content: input.text }]
        : input.context !== undefined
          ? [{ role: 'user' as const, content: stringify(input.context) }]
          : [])
  }

  private async _initialMessages(input: AgentInput): Promise<ModelMessage[]> {
    const promptService = this.ctx.reflect.get('systemPrompt', false) as
      | { assemble(options?: object, ctx?: Context): Promise<{ text: string }> }
      | undefined
    const assembled = promptService
      ? (await promptService.assemble({}, this.ctx)).text.trim()
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
    if (assistant.content || toolCalls.length) next.push(assistant)

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
    const scoped = this.ctx.reflect.get('tools', false) as ToolsService | undefined
    const tools = scoped ?? (this.ctx as unknown as { tools?: ToolsService }).tools
    if (!tools) throw new AgentError('tools service is required')
    return tools
  }

  private async _resolveAvailableTools(): Promise<readonly ToolDefinition[]> {
    // Executable tools are the single source of truth. When a system-prompt
    // service is mounted, its assembled schema list narrows what the model
    // sees — but only to tools that are actually registered, so a declared
    // schema can never advertise an un-executable stub.
    const executable = this._tools().list()
    const promptService = this.ctx.reflect.get('systemPrompt', false) as
      | { toolSchemas(options?: object): Promise<readonly ToolSchemaSnapshot[]> }
      | undefined
    if (!promptService) return executable
    const schemas = await promptService.toolSchemas()
    if (!schemas.length) return executable
    const byName = new Map(executable.map(tool => [tool.schema.name, tool] as const))
    return schemas
      .map(schema => byName.get(schema.name))
      .filter((tool): tool is ToolDefinition => tool !== undefined)
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
