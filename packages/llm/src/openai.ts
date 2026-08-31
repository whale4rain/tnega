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
import { DEFAULT_DEEPSEEK_MODEL } from './models.js'
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
  stringifyArguments,
} from './shared.js'
import type { OpenAICompatibleConfig } from './types.js'

interface OpenAICompatibleToolCall {
  id?: unknown
  type?: unknown
  function?: {
    name?: unknown
    arguments?: unknown
  }
}

interface OpenAICompatibleChoice {
  message?: {
    content?: string | null
    tool_calls?: unknown
  }
  finish_reason?: string | null
}

interface OpenAICompatiblePayload {
  choices?: unknown
  data?: unknown
}

interface OpenAIStreamChoice {
  delta?: {
    content?: string | null
    tool_calls?: unknown
  }
  finish_reason?: string | null
}

interface OpenAIStreamToolCall {
  index?: unknown
  id?: unknown
  function?: {
    name?: unknown
    arguments?: unknown
  }
}

interface RequestPayload {
  url: string
  init: RequestInit
}

export function openaiCompatAdapter(config: OpenAICompatibleConfig = {}): LLMAdapter {
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
          for await (const event of parseOpenAIStream(response.body)) {
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

export async function listModels(config: OpenAICompatibleConfig = {}): Promise<string[]> {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const headers = authHeaders(config.apiKey)
  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, { headers })
  } catch (error) {
    throw new OpenAICompatibleError(
      0,
      `model list request failed: ${errorMessage(error)}`,
    )
  }
  await assertOk(response)
  const payload = await parseJson(response)
  const data = (payload as OpenAICompatiblePayload | null)?.data
  if (!Array.isArray(data)) {
    throw new OpenAICompatibleError(
      response.status,
      'model list response did not contain an array in data',
    )
  }
  return data
    .map((entry) => {
      const record = entry as { id?: unknown } | null
      return typeof record?.id === 'string' ? record.id : ''
    })
    .filter(Boolean)
}

function buildRequest(
  messages: readonly ModelMessage[],
  tools: readonly ToolDefinition[],
  config: OpenAICompatibleConfig,
  signal: AbortSignal | undefined,
  stream = false,
): RequestPayload {
  const body: Record<string, unknown> = {
    model: config.model ?? DEFAULT_DEEPSEEK_MODEL,
    messages: messages.map(toOpenAIMessage),
  }
  if (stream) body.stream = true
  if (tools.length) {
    body.tools = tools.map(toOpenAITool)
  }
  if (config.temperature !== undefined) body.temperature = config.temperature
  if (config.maxTokens !== undefined) body.max_tokens = config.maxTokens

  return {
    url: `${normalizeBaseUrl(config.baseUrl)}/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(config.apiKey),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
  }
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

function toOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  }
  if (message.role === 'tool' && message.name) payload.name = message.name
  if (message.tool_call_id) payload.tool_call_id = message.tool_call_id
  if (message.tool_calls?.length) {
    payload.tool_calls = message.tool_calls.map(call => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: stringifyArguments(call.arguments),
      },
    }))
  }
  return payload
}

function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.schema.name,
      description: tool.schema.description,
      parameters: tool.schema.parameters ?? { type: 'object', properties: {} },
    },
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
  const record = payload as OpenAICompatiblePayload | null
  const choices = Array.isArray(record?.choices)
    ? record.choices as OpenAICompatibleChoice[]
    : []
  const choice = choices[0]
  const rawContent = choice?.message?.content
  const content = typeof rawContent === 'string' ? rawContent : undefined
  const toolCalls = parseToolCalls(choice?.message?.tool_calls)
  const finishReason = toFinishReason(
    choice?.finish_reason,
    content,
    toolCalls !== undefined,
  )
  const completion: LLMCompletion = {
    finishReason,
  }
  if (content !== undefined) completion.content = content
  if (toolCalls !== undefined) completion.toolCalls = toolCalls
  return completion
}

function parseToolCalls(value: unknown): LLMToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined
  const calls: LLMToolCall[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as OpenAICompatibleToolCall
    const name = typeof item.function?.name === 'string' ? item.function.name : ''
    if (!name) continue
    const id = typeof item.id === 'string' && item.id
      ? item.id
      : `call_${calls.length + 1}`
    const rawArguments = typeof item.function?.arguments === 'string'
      ? item.function.arguments
      : ''
    calls.push({
      id,
      name,
      arguments: parseArguments(rawArguments),
    })
  }
  return calls.length ? calls : undefined
}

function toFinishReason(
  raw: string | null | undefined,
  content: string | undefined,
  hasToolCalls: boolean,
): AgentFinishReason {
  if (raw === 'stop' || (raw === undefined && content !== undefined && !hasToolCalls)) {
    return 'stop'
  }
  if (raw === 'length') return 'length'
  if (raw === 'tool_calls' || hasToolCalls) return 'tool_calls'
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

async function* parseOpenAIStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<LLMStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let messageId: string = randomUUID()
  let model: string | undefined
  let messageStarted = false
  let finishReason: string | null | undefined
  const calls = new Map<number, {
    index: number
    id: string
    name: string
    arguments: string
    emitted: boolean
  }>()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') {
          yield* finalizeStreamEvents(messageId, content, calls, finishReason)
          return
        }
        let payload: unknown
        try {
          payload = JSON.parse(data) as unknown
        } catch {
          continue
        }
        const events = processStreamChunk(
          payload,
          { messageId, model, messageStarted },
          { content, finishReason },
          calls,
        )
        messageId = events.messageId
        model = events.model
        messageStarted = true
        content = events.content
        finishReason = events.finishReason
        for (const event of events.events) yield event
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

  yield* finalizeStreamEvents(messageId, content, calls, finishReason)
}

interface StreamChunkState {
  messageId: string
  model: string | undefined
  messageStarted: boolean
  content: string
  finishReason: string | null | undefined
}

function processStreamChunk(
  payload: unknown,
  state: Pick<StreamChunkState, 'messageId' | 'model' | 'messageStarted'>,
  progress: Pick<StreamChunkState, 'content' | 'finishReason'>,
  calls: Map<number, {
    index: number
    id: string
    name: string
    arguments: string
    emitted: boolean
  }>,
): StreamChunkState & { events: LLMStreamEvent[] } {
  const record = payload as {
    id?: unknown
    model?: unknown
    choices?: unknown
  } | null
  const events: LLMStreamEvent[] = []
  let messageId = state.messageId
  let model = state.model
  let messageStarted = state.messageStarted
  let content = progress.content
  let finishReason = progress.finishReason

  if (typeof record?.id === 'string' && record.id) messageId = record.id
  if (typeof record?.model === 'string' && record.model) model = record.model
  if (!messageStarted) {
    messageStarted = true
    const start = {
      type: 'message_start' as const,
      id: messageId,
      ...(model ? { model } : {}),
    }
    events.push(start)
  }

  const choices = Array.isArray(record?.choices)
    ? record.choices as OpenAIStreamChoice[]
    : []
  const choice = choices[0]
  if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
    finishReason = choice.finish_reason
  }
  const delta = choice?.delta
  if (typeof delta?.content === 'string' && delta.content) {
    content += delta.content
    events.push({ type: 'message_delta', id: messageId, delta: delta.content })
  }
  if (Array.isArray(delta?.tool_calls)) {
    for (const entry of delta.tool_calls as OpenAIStreamToolCall[]) {
      const index = typeof entry.index === 'number' ? entry.index : 0
      let call = calls.get(index)
      if (!call) {
        call = { index, id: '', name: '', arguments: '', emitted: false }
        calls.set(index, call)
      }
      if (typeof entry.id === 'string' && entry.id) call.id = entry.id
      if (typeof entry.function?.name === 'string' && entry.function.name) {
        call.name = entry.function.name
      }
      if (typeof entry.function?.arguments === 'string') {
        call.arguments += entry.function.arguments
      }
      if (!call.emitted && call.id && call.name) {
        call.emitted = true
        events.push({
          type: 'toolcall_start',
          id: call.id,
          index,
          name: call.name,
        })
      }
    }
  }

  return {
    messageId,
    model,
    messageStarted,
    content,
    finishReason,
    events,
  }
}

function finalizeStreamEvents(
  messageId: string,
  content: string,
  calls: Map<number, {
    index: number
    id: string
    name: string
    arguments: string
    emitted: boolean
  }>,
  finishReason: string | null | undefined,
): LLMStreamEvent[] {
  const events: LLMStreamEvent[] = []
  const toolCalls: LLMToolCall[] = []
  for (const call of calls.values()) {
    if (!call.emitted) continue
    events.push({
      type: 'toolcall_end',
      id: call.id,
      index: call.index,
      name: call.name,
      arguments: parseArguments(call.arguments),
    })
    toolCalls.push({
      id: call.id,
      name: call.name,
      arguments: parseArguments(call.arguments),
    })
  }
  events.push({
    type: 'message_stop',
    id: messageId,
    finishReason: toFinishReason(finishReason, content, toolCalls.length > 0),
  })
  return events
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
