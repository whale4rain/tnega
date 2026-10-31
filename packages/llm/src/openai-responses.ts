import { createHash, randomUUID } from 'node:crypto'
import type { AgentFinishReason, LLMAdapter, LLMCompletion, LLMStreamEvent, LLMToolCall } from '@tnega/agent'
import type { ModelAttachment, ModelMessage, ModelUsage } from '@tnega/session'
import type { ToolDefinition } from '@tnega/tools'
import { OpenAICompatibleError } from './errors.js'
import { imageKey, prepareWireImages, type WireImages } from './files.js'
import {
  assertOk,
  combineSignal,
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_RETRY_DELAY_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  errorMessage,
  imageDataUrl,
  isExternalAbort,
  isRetryableStatus,
  normalizeBaseUrl,
  parseArguments,
  sleep,
  statelessResponses,
  stringifyArguments,
  withCallOverrides,
} from './shared.js'
import type { LlmConfig } from './types.js'

/**
 * OpenAI Responses API (`POST /responses`), streamed. Used for ChatGPT
 * sign-in, whose Codex backend speaks only this API, and usable for any
 * Responses endpoint.
 */
export interface OpenAIResponsesConfig extends LlmConfig {
  /** Full endpoint URL; defaults to `${baseUrl}/responses`. */
  url?: string
  /** Headers added to every request, resolved per request (fresh tokens). */
  headers?: (signal?: AbortSignal) => Record<string, string> | Promise<Record<string, string>>
  /**
   * Fixed top-level `instructions`. When set, the conversation's own system
   * prompt travels as a developer message instead.
   */
  instructions?: string
  /** Whether the provider keeps the response; the ChatGPT backend requires false. */
  store?: boolean
}

type InputItem = Record<string, unknown>

/** The system prompt as `instructions`, the rest of the conversation as Responses input items. */
export function toResponsesInput(
  messages: readonly ModelMessage[],
  fixedInstructions?: string,
  fileId?: (attachment: ModelAttachment) => string | undefined,
): { instructions?: string; input: InputItem[] } {
  const input: InputItem[] = []
  let instructions = fixedInstructions
  let pendingToolImages: ModelAttachment[] = []
  const flushToolImages = (): void => {
    if (!pendingToolImages.length) return
    input.push({ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'Images returned by the tool calls above:' },
      ...pendingToolImages.map(image => toResponsesImage(image, fileId)),
    ] })
    pendingToolImages = []
  }
  messages.forEach((message, index) => {
    if (message.role !== 'tool') flushToolImages()
    if (message.role === 'system') {
      if (index === 0 && instructions === undefined) instructions = message.content
      else input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: message.content }] })
    } else if (message.role === 'user') {
      input.push({ type: 'message', role: 'user', content: [
        ...(message.content ? [{ type: 'input_text', text: message.content }] : []),
        ...(message.attachments ?? []).map(image => toResponsesImage(image, fileId)),
      ] })
    } else if (message.role === 'assistant') {
      if (message.content) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: stringifyArguments(call.arguments) })
      }
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id ?? '', output: message.content })
      if (message.attachments?.length) pendingToolImages.push(...message.attachments)
    }
  })
  flushToolImages()
  return { ...(instructions !== undefined ? { instructions } : {}), input }
}

function toResponsesImage(
  attachment: ModelAttachment,
  fileId?: (attachment: ModelAttachment) => string | undefined,
): InputItem {
  const id = fileId?.(attachment)
  // A Files API reference keeps the body small and the prompt prefix stable.
  if (id) return { type: 'input_image', file_id: id }
  return { type: 'input_image', image_url: imageDataUrl(attachment) }
}

function toResponsesTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.schema.name,
    description: tool.schema.description,
    parameters: tool.schema.parameters ?? { type: 'object', properties: {} },
    strict: false,
  }
}

/** A cheap identity of one message, so a chained turn can prove it shares the prefix. */
function fingerprint(message: ModelMessage): string {
  const images = (message.attachments ?? []).map(imageKey).join(',')
  const calls = (message.tool_calls ?? []).map(call => call.id).join(',')
  const text = createHash('sha256').update(message.content).digest('hex').slice(0, 32)
  return `${message.role}|${message.tool_call_id ?? ''}|${message.content.length}|${text}|${calls}|${images}`
}

async function buildRequest(
  wire: WireImages,
  tools: readonly ToolDefinition[],
  config: OpenAIResponsesConfig,
  signal: AbortSignal | undefined,
  chain?: { responseId: string; skip: number },
): Promise<{ url: string; init: RequestInit }> {
  // A chained request sends only what the provider has not seen yet.
  const sent = chain ? wire.messages.slice(chain.skip) : wire.messages
  const { instructions, input } = toResponsesInput(sent, config.instructions, wire.fileId)
  const body: Record<string, unknown> = {
    model: config.model,
    ...(instructions !== undefined ? { instructions } : {}),
    input,
    stream: true,
    store: chain ? true : config.store ?? false,
    ...(chain ? { previous_response_id: chain.responseId } : {}),
  }
  if (tools.length) {
    body.tools = tools.map(toResponsesTool)
    body.tool_choice = 'auto'
    body.parallel_tool_calls = false
  }
  if (config.reasoningEffort) body.reasoning = { effort: config.reasoningEffort, summary: 'auto' }
  else if (config.temperature !== undefined) body.temperature = config.temperature
  if (config.maxTokens !== undefined) body.max_output_tokens = config.maxTokens
  const extra = await config.headers?.(signal) ?? {}
  return {
    url: config.url ?? `${normalizeBaseUrl(config.baseUrl)}/responses`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
  }
}

export function openaiResponsesAdapter(config: OpenAIResponsesConfig): LLMAdapter {
  // Learned once per adapter: the endpoint wants fixed instructions.
  let fixedInstructions = config.instructions
  // Server-side conversation state, when the route actually keeps it. DeepSeek's
  // Responses endpoint documents itself as stateless, so stateful parameters are
  // never sent there; other routes are trusted until a reply says otherwise.
  let stateful = config.stateful !== false && config.store !== false && !statelessResponses(config.baseUrl)
  let last: { id: string; prints: string[] } | undefined
  const stream = async function* (
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
    options: { signal?: AbortSignal; maxTokens?: number },
  ): AsyncGenerator<LLMStreamEvent> {
    const effective = withCallOverrides(config, options)
    const timeoutMs = effective.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
    const maxRetries = effective.maxRetries ?? DEFAULT_LLM_MAX_RETRIES
    const retryDelayMs = effective.retryDelayMs ?? DEFAULT_LLM_RETRY_DELAY_MS
    for (let attempt = 0; ; attempt += 1) {
      const settings = fixedInstructions !== undefined
        ? { ...effective, instructions: fixedInstructions, ...(stateful ? { store: true } : {}) }
        : { ...effective, ...(stateful ? { store: true } : {}) }
      const wire = await prepareWireImages(messages, effective)
      const prints = wire.messages.map(fingerprint)
      // Only a strict prefix of the conversation can be chained: a compaction,
      // an edit, or a dropped image resends everything instead.
      const chain = stateful && last && prints.length > last.prints.length && last.prints.every((print, index) => print === prints[index])
        ? { responseId: last.id, skip: last.prints.length }
        : undefined
      const request = await buildRequest(wire, tools, settings, combineSignal(options.signal, timeoutMs), chain)
      let response: Response
      try {
        response = await (config.fetch ?? fetch)(request.url, request.init)
      } catch (error) {
        if (isExternalAbort(error, options.signal)) throw new OpenAICompatibleError(0, `LLM stream aborted: ${errorMessage(error)}`)
        if (attempt >= maxRetries) throw new OpenAICompatibleError(0, `LLM stream failed: ${errorMessage(error)}`)
        await sleep(retryDelayMs * 2 ** attempt)
        continue
      }
      if (!response.ok || !response.body) {
        if (isRetryableStatus(response.status) && attempt < maxRetries) {
          await response.body?.cancel()
          await sleep(retryDelayMs * 2 ** attempt)
          continue
        }
        if (!response.ok) {
          try {
            await assertOk(response, effective.apiKey)
          } catch (error) {
            const rejectedInstructions = error instanceof OpenAICompatibleError && error.status === 400
              && /instruction/i.test(error.detail ?? '') && fixedInstructions === undefined && config.fallbackInstructions
            if (rejectedInstructions) {
              fixedInstructions = await config.fallbackInstructions!()
              continue
            }
            // A route that cannot keep state says so; send the whole
            // conversation from then on rather than failing the turn.
            const stateRejected = error instanceof OpenAICompatibleError && error.status === 400
              && /store|previous_response_id/iu.test(`${error.message} ${error.detail ?? ''}`)
            if (stateRejected && stateful) {
              stateful = false
              last = undefined
              continue
            }
            throw error
          }
        }
        throw new OpenAICompatibleError(response.status, 'LLM stream response had no body')
      }
      let meta: ResponsesMeta = {}
      yield* parseResponsesStream(response.body, info => { meta = { ...meta, ...info } })
      // Remember the server's copy only when it says it kept one; otherwise every
      // later request resends the conversation and chaining stays off.
      if (meta.id && meta.store === true) last = { id: meta.id, prints }
      else {
        last = undefined
        if (meta.store === false) stateful = false
      }
      return
    }
  }
  return {
    stream,
    async complete(messages, tools, options) {
      return completionFromEvents(stream(messages, tools, options))
    },
  }
}

async function completionFromEvents(events: AsyncIterable<LLMStreamEvent>): Promise<LLMCompletion> {
  let content = ''
  let reasoning = ''
  const toolCalls: LLMToolCall[] = []
  let finishReason: AgentFinishReason = 'stop'
  let usage: ModelUsage | undefined
  for await (const event of events) {
    if (event.type === 'message_delta') content += event.delta
    else if (event.type === 'reasoning_delta') reasoning += event.delta
    else if (event.type === 'toolcall_end') toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments })
    else if (event.type === 'message_stop') {
      finishReason = event.finishReason
      usage = event.usage
    }
  }
  return {
    finishReason,
    ...(content ? { content } : {}),
    ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
  }
}

interface ResponsesEvent {
  type?: string
  delta?: unknown
  output_index?: unknown
  item?: { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown }
  response?: {
    id?: unknown
    model?: unknown
    status?: unknown
    store?: unknown
    incomplete_details?: { reason?: unknown } | null
    usage?: unknown
    error?: { message?: unknown } | null
  }
  message?: unknown
  code?: unknown
}

/** Read a Responses SSE stream into the agent's stream events. */
export interface ResponsesMeta {
  /** The response id, for `previous_response_id` on the next turn. */
  id?: string
  /** Whether the provider kept this response server-side. */
  store?: boolean
}

export async function* parseResponsesStream(
  body: ReadableStream<Uint8Array>,
  onMeta?: (meta: ResponsesMeta) => void,
): AsyncGenerator<LLMStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let id: string = randomUUID()
  let started = false
  let calls = 0
  let stopped = false
  const start = function* (model?: unknown): Generator<LLMStreamEvent> {
    if (started) return
    started = true
    yield { type: 'message_start', id, ...(typeof model === 'string' ? { model } : {}) }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let event: ResponsesEvent
        try { event = JSON.parse(data) as ResponsesEvent } catch { continue }
        switch (event.type) {
          case 'response.created':
            if (typeof event.response?.id === 'string') id = event.response.id
            onMeta?.({ id, ...(typeof event.response?.store === 'boolean' ? { store: event.response.store } : {}) })
            yield* start(event.response?.model)
            break
          case 'response.output_text.delta':
            yield* start()
            if (typeof event.delta === 'string' && event.delta) yield { type: 'message_delta', id, delta: event.delta }
            break
          // `summary: 'auto'` (set with an effort) streams a readable summary of the hidden reasoning.
          case 'response.reasoning_summary_text.delta':
            yield* start()
            if (typeof event.delta === 'string' && event.delta) yield { type: 'reasoning_delta', id, delta: event.delta }
            break
          case 'response.reasoning_summary_part.done':
            yield* start()
            yield { type: 'reasoning_delta', id, delta: '\n\n' }
            break
          case 'response.output_item.added':
            if (event.item?.type === 'function_call' && typeof event.item.call_id === 'string' && typeof event.item.name === 'string') {
              yield* start()
              yield { type: 'toolcall_start', id: event.item.call_id, index: calls, name: event.item.name }
            }
            break
          case 'response.output_item.done':
            if (event.item?.type === 'function_call' && typeof event.item.call_id === 'string' && typeof event.item.name === 'string') {
              yield* start()
              yield {
                type: 'toolcall_end', id: event.item.call_id, index: calls, name: event.item.name,
                arguments: parseArguments(typeof event.item.arguments === 'string' ? event.item.arguments : ''),
              }
              calls += 1
            }
            break
          case 'response.completed':
          case 'response.incomplete': {
            yield* start(event.response?.model)
            const usage = parseResponsesUsage(event.response?.usage)
            onMeta?.({ id, ...(typeof event.response?.store === 'boolean' ? { store: event.response.store } : {}) })
            const truncated = event.response?.status === 'incomplete' && event.response.incomplete_details?.reason === 'max_output_tokens'
            stopped = true
            yield { type: 'message_stop', id, finishReason: truncated ? 'length' : calls ? 'tool_calls' : 'stop', ...(usage ? { usage } : {}) }
            break
          }
          case 'response.failed':
          case 'error': {
            const message = event.response?.error?.message ?? event.message ?? 'the model returned an error'
            throw new OpenAICompatibleError(0, `LLM stream failed: ${String(message)}`)
          }
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already closed by abort */ }
  }
  if (!stopped) throw new OpenAICompatibleError(0, 'LLM stream ended before the response completed')
}

/** Responses usage: `input_tokens` is the whole prompt, cached tokens a part of it. */
export function parseResponsesUsage(value: unknown): ModelUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as {
    input_tokens?: unknown
    output_tokens?: unknown
    total_tokens?: unknown
    input_tokens_details?: { cached_tokens?: unknown } | null
    output_tokens_details?: { reasoning_tokens?: unknown } | null
  }
  const count = (input: unknown): number | undefined => typeof input === 'number' && Number.isFinite(input) && input >= 0 ? Math.floor(input) : undefined
  const promptTokens = count(raw.input_tokens)
  const completionTokens = count(raw.output_tokens)
  if (promptTokens === undefined || completionTokens === undefined) return undefined
  const usage: ModelUsage = { promptTokens, completionTokens }
  const cached = count(raw.input_tokens_details?.cached_tokens)
  if (cached !== undefined) usage.cachedTokens = cached
  const reasoning = count(raw.output_tokens_details?.reasoning_tokens)
  if (reasoning !== undefined) usage.reasoningTokens = reasoning
  const total = count(raw.total_tokens)
  if (total !== undefined) usage.totalTokens = total
  return usage
}
