import { randomUUID } from 'node:crypto'
import type {
  AgentFinishReason,
  LLMAdapter,
  LLMCompletion,
  LLMStreamEvent,
  LLMToolCall,
} from '@tnega/agent'
import type { ModelMessage } from '@tnega/session'
import type { ToolDefinition } from '@tnega/tools'
import { OpenAICompatibleError } from './errors.js'
import { DEFAULT_MODEL } from './models.js'
import {
  assertOk,
  combineSignal,
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_RETRY_DELAY_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  errorMessage,
  isAbortLike,
  isExternalAbort,
  isRetryableStatus,
  normalizeBaseUrl,
  parseArguments,
  parseJson,
  sleep,
} from './shared.js'
import type { LlmConfig } from './types.js'

export type AnthropicMessagesConfig = LlmConfig

interface AnthropicContentBlock {
  type?: unknown
  id?: unknown
  name?: unknown
  text?: unknown
  input?: unknown
  partial_json?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
  index?: unknown
}

interface AnthropicMessagePayload {
  id?: unknown
  model?: unknown
  content?: unknown
  stop_reason?: unknown
  error?: { message?: unknown }
  type?: unknown
}

interface AnthropicToolCallState {
  index: number
  id: string
  name: string
  rawArguments: string
  emitted: boolean
  finalized: boolean
}

interface RequestPayload {
  url: string
  init: RequestInit
}

const ANTHROPIC_VERSION = '2023-06-01'

export function anthropicMessagesAdapter(
  config: AnthropicMessagesConfig = {},
): LLMAdapter {
  return {
    async complete(messages, tools, options) {
      const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
      const maxRetries = config.maxRetries ?? DEFAULT_LLM_MAX_RETRIES
      const retryDelayMs = config.retryDelayMs ?? DEFAULT_LLM_RETRY_DELAY_MS
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const request = buildRequest(
          messages,
          tools,
          config,
          combineSignal(options.signal, timeoutMs),
        )
        try {
          const response = await fetch(request.url, request.init)
          if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
            return parseResponse(response, config.apiKey)
          }
          await response.body?.cancel()
        } catch (error) {
          if (isExternalAbort(error, options.signal)) {
            throw new OpenAICompatibleError(
              0,
              `LLM request aborted: ${errorMessage(error)}`,
            )
          }
          if (attempt >= maxRetries) {
            throw toRequestError(error, timeoutMs)
          }
        }
        await sleep(retryDelayMs * 2 ** attempt)
      }
      throw new OpenAICompatibleError(0, 'LLM request failed')
    },
    async *stream(messages, tools, options) {
      const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
      const maxRetries = config.maxRetries ?? DEFAULT_LLM_MAX_RETRIES
      const retryDelayMs = config.retryDelayMs ?? DEFAULT_LLM_RETRY_DELAY_MS
      for (let attempt = 0; ; attempt += 1) {
        const request = buildRequest(
          messages,
          tools,
          config,
          combineSignal(options.signal, timeoutMs),
          true,
        )
        let response: Response
        try {
          response = await fetch(request.url, request.init)
        } catch (error) {
          if (isExternalAbort(error, options.signal)) {
            throw new OpenAICompatibleError(
              0,
              `LLM stream aborted: ${errorMessage(error)}`,
            )
          }
          if (attempt >= maxRetries) {
            throw toStreamError(error, timeoutMs)
          }
          await sleep(retryDelayMs * 2 ** attempt)
          continue
        }

        if (!response.ok || !response.body) {
          if (isRetryableStatus(response.status) && attempt < maxRetries) {
            await response.body?.cancel()
            await sleep(retryDelayMs * 2 ** attempt)
            continue
          }
          if (!response.ok) await assertOk(response, config.apiKey)
          throw new OpenAICompatibleError(
            response.status,
            'LLM stream response had no body',
          )
        }

        let sawEvent = false
        try {
          for await (const event of parseAnthropicStream(response.body)) {
            sawEvent = true
            yield event
          }
          return
        } catch (error) {
          if (isExternalAbort(error, options.signal)) {
            throw new OpenAICompatibleError(
              0,
              `LLM stream aborted: ${errorMessage(error)}`,
            )
          }
          if (sawEvent || attempt >= maxRetries) {
            throw toStreamError(error, timeoutMs)
          }
          await sleep(retryDelayMs * 2 ** attempt)
        }
      }
    },
  }
}

function buildRequest(
  messages: readonly ModelMessage[],
  tools: readonly ToolDefinition[],
  config: AnthropicMessagesConfig,
  signal: AbortSignal | undefined,
  stream = false,
): RequestPayload {
  const body: Record<string, unknown> = {
    model: config.model ?? DEFAULT_MODEL,
    max_tokens: config.maxTokens ?? 4096,
    messages: toAnthropicMessages(messages),
  }
  if (stream) body.stream = true
  const system = systemPrompt(messages)
  if (system) body.system = system
  if (tools.length) {
    body.tools = tools.map(toAnthropicTool)
  }
  if (config.temperature !== undefined) body.temperature = config.temperature

  return {
    url: anthropicMessagesUrl(config.baseUrl),
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
  }
}

function anthropicMessagesUrl(baseUrl: string | undefined): string {
  const normalized = normalizeBaseUrl(baseUrl)
  return normalized.endsWith('/messages') ? normalized : `${normalized}/messages`
}

function systemPrompt(messages: readonly ModelMessage[]): string {
  return messages
    .filter(message => message.role === 'system')
    .map(message => String(message.content ?? ''))
    .join('\n\n')
}

function toAnthropicMessages(messages: readonly ModelMessage[]): unknown[] {
  const result: unknown[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      const toolResult: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: String(message.content ?? ''),
      }
      if (message.toolError) toolResult.is_error = true
      result.push({
        role: 'user',
        content: [toolResult],
      })
      continue
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      result.push({
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.tool_calls.map(call => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: typeof call.arguments === 'object' && call.arguments !== null
              ? call.arguments
              : parseArguments(String(call.arguments ?? '')),
          })),
        ],
      })
      continue
    }
    result.push({
      role: message.role,
      content: String(message.content ?? ''),
    })
  }
  return result
}

function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.schema.name,
    ...(tool.schema.description ? { description: tool.schema.description } : {}),
    input_schema: tool.schema.parameters ?? { type: 'object', properties: {} },
  }
}

async function parseResponse(
  response: Response,
  apiKey: string | undefined,
): Promise<LLMCompletion> {
  await assertOk(response, apiKey)
  const payload = await parseJson(response)
  return parseCompletion(payload)
}

function parseCompletion(payload: unknown): LLMCompletion {
  const record = payload as AnthropicMessagePayload | null
  const blocks = Array.isArray(record?.content)
    ? record.content as AnthropicContentBlock[]
    : []
  const text = blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
  const toolCalls = parseToolCalls(blocks)
  const finishReason = toFinishReason(
    record?.stop_reason,
    text,
    toolCalls.length > 0,
  )
  const completion: LLMCompletion = { finishReason }
  if (text) completion.content = text
  if (toolCalls.length) completion.toolCalls = toolCalls
  return completion
}

function parseToolCalls(blocks: AnthropicContentBlock[]): LLMToolCall[] {
  const calls: LLMToolCall[] = []
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    const name = typeof block.name === 'string' ? block.name : ''
    if (!name) continue
    const id = typeof block.id === 'string' && block.id
      ? block.id
      : `toolu_${calls.length + 1}`
    calls.push({
      id,
      name,
      arguments: block.input ?? {},
    })
  }
  return calls
}

function toFinishReason(
  raw: unknown,
  content: string,
  hasToolCalls: boolean,
): AgentFinishReason {
  if (raw === 'end_turn' || raw === 'stop_sequence') return 'stop'
  if (raw === 'max_tokens') return 'length'
  if (raw === 'tool_use' || hasToolCalls) return 'tool_calls'
  if (content) return 'stop'
  return 'error'
}

function toRequestError(error: unknown, timeoutMs: number): OpenAICompatibleError {
  if (isAbortLike(error)) {
    return new OpenAICompatibleError(
      0,
      `LLM request timed out after ${timeoutMs}ms`,
    )
  }
  return new OpenAICompatibleError(0, `LLM request failed: ${errorMessage(error)}`)
}

async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<LLMStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let messageId: string = randomUUID()
  let model: string | undefined
  let messageStarted = false
  let text = ''
  let stopReason: unknown
  let stopped = false
  let textBlockIndex: number | undefined
  const calls = new Map<number, AnthropicToolCallState>()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (!data) continue
          let payload: unknown
          try {
            payload = JSON.parse(data) as unknown
          } catch {
            continue
          }
          const record = payload as AnthropicMessagePayload | null
          if (record?.type === 'error') {
            const message = typeof record.error?.message === 'string'
              ? record.error.message
              : 'LLM stream returned an error event'
            throw new OpenAICompatibleError(0, `LLM stream failed: ${message}`)
          }
          if (record?.type === 'ping') continue
          if (record?.type === 'message_start') {
            const start = record as { message?: AnthropicMessagePayload }
            messageId = typeof start.message?.id === 'string' && start.message.id
              ? start.message.id
              : randomUUID()
            model = typeof start.message?.model === 'string'
              ? start.message.model
              : undefined
            messageStarted = true
            yield {
              type: 'message_start',
              id: messageId,
              ...(model ? { model } : {}),
            }
            continue
          }
          if (record?.type === 'content_block_start') {
            const block = (record as { content_block?: AnthropicContentBlock })
              .content_block
            const index = toIndex(record)
            if (block?.type === 'text') {
              textBlockIndex = index
              if (typeof block.text === 'string' && block.text) {
                text += block.text
                yield { type: 'message_delta', id: messageId, delta: block.text }
              }
            } else if (block?.type === 'tool_use') {
              const call = calls.get(index) ?? {
                index,
                id: typeof block.id === 'string' ? block.id : '',
                name: typeof block.name === 'string' ? block.name : '',
                rawArguments: typeof block.partial_json === 'string'
                  ? block.partial_json
                  : '',
                emitted: false,
                finalized: false,
              }
              calls.set(index, call)
              if (!call.emitted && call.id && call.name) {
                call.emitted = true
                yield {
                  type: 'toolcall_start',
                  id: call.id,
                  index,
                  name: call.name,
                }
              }
            }
            continue
          }
          if (record?.type === 'content_block_delta') {
            const block = (record as { delta?: AnthropicContentBlock }).delta
            const index = toIndex(record)
            if (block?.type === 'text_delta' && typeof block.text === 'string') {
              if (textBlockIndex === undefined) textBlockIndex = index
              if (textBlockIndex === index && block.text) {
                text += block.text
                yield { type: 'message_delta', id: messageId, delta: block.text }
              }
            } else if (block?.type === 'input_json_delta') {
              const call = calls.get(index)
              if (call && typeof block.partial_json === 'string') {
                call.rawArguments += block.partial_json
              }
            }
            continue
          }
          if (record?.type === 'content_block_stop') {
            const block = record as AnthropicContentBlock
            const index = toIndex(block)
            const call = calls.get(index)
            if (call && !call.finalized) {
              call.finalized = true
              if (!call.name) {
                const partial = parseArguments(call.rawArguments)
                if (partial && typeof partial === 'object') {
                  const name = (partial as { name?: unknown }).name
                  if (typeof name === 'string') call.name = name
                }
              }
              if (!call.emitted && call.id && call.name) {
                call.emitted = true
                yield {
                  type: 'toolcall_start',
                  id: call.id,
                  index,
                  name: call.name,
                }
              }
              yield {
                type: 'toolcall_end',
                id: call.id || `toolu_${index + 1}`,
                index,
                name: call.name,
                arguments: parseArguments(call.rawArguments),
              }
            }
            continue
          }
          if (record?.type === 'message_delta') {
            const delta = (record as { delta?: { stop_reason?: unknown } }).delta
            if (delta?.stop_reason !== undefined) {
              stopReason = delta.stop_reason
            }
            continue
          }
          if (record?.type === 'message_stop') {
            if (!messageStarted) {
              messageStarted = true
              yield {
                type: 'message_start',
                id: messageId,
                ...(model ? { model } : {}),
              }
            }
            stopped = true
            yield {
              type: 'message_stop',
              id: messageId,
              finishReason: toFinishReason(stopReason, text, calls.size > 0),
            }
            continue
          }
        }
      }
    }
  } finally {
    if (reader.releaseLock) {
      try {
        reader.releaseLock()
      } catch {
        // stream may already be closed by abort
      }
    }
  }

  if (!messageStarted) {
    yield {
      type: 'message_start',
      id: messageId,
      ...(model ? { model } : {}),
    }
  }
  if (!stopped) {
    yield {
      type: 'message_stop',
      id: messageId,
      finishReason: toFinishReason(stopReason, text, calls.size > 0),
    }
  }
}

function toIndex(block: AnthropicContentBlock): number {
  return typeof block.index === 'number' ? block.index : 0
}

function toStreamError(error: unknown, timeoutMs: number): OpenAICompatibleError {
  if (isAbortLike(error)) {
    return new OpenAICompatibleError(
      0,
      `LLM stream timed out after ${timeoutMs}ms`,
    )
  }
  return new OpenAICompatibleError(0, `LLM stream failed: ${errorMessage(error)}`)
}
