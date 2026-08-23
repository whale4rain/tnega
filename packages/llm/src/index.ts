import type {
  AgentFinishReason,
  LLMAdapter,
  LLMCompletion,
  LLMToolCall,
} from '@tnega/agent'
import type { ModelMessage } from '@tnega/session'
import type { ToolDefinition } from '@tnega/tools'

export const DEFAULT_OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'

export interface OpenAICompatibleConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  temperature?: number
  maxTokens?: number
}

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

interface RequestPayload {
  url: string
  init: RequestInit
}

export class OpenAICompatibleError extends Error {
  override name = 'OpenAICompatibleError'

  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
  }
}

export function openaiCompatAdapter(config: OpenAICompatibleConfig = {}): LLMAdapter {
  return {
    async complete(messages, tools, options) {
      const request = buildRequest(messages, tools, config, options.signal)
      let response: Response
      try {
        response = await fetch(request.url, request.init)
      } catch (error) {
        throw new OpenAICompatibleError(
          0,
          `LLM request failed: ${errorMessage(error)}`,
        )
      }
      return parseResponse(response)
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
): RequestPayload {
  const body: Record<string, unknown> = {
    model: config.model ?? DEFAULT_DEEPSEEK_MODEL,
    messages: messages.map(toOpenAIMessage),
  }
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

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_OPENCODE_GO_BASE_URL).replace(/\/+$/, '')
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

function stringifyArguments(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? '{}'
  } catch {
    return '{}'
  }
}

async function parseResponse(response: Response): Promise<LLMCompletion> {
  await assertOk(response)
  const payload = await parseJson(response)
  return parseCompletion(payload)
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail: string | undefined
  try {
    const text = await response.text()
    if (text.trim()) detail = text.slice(0, 2000)
  } catch {
    detail = undefined
  }
  throw new OpenAICompatibleError(
    response.status,
    `LLM request failed with status ${response.status}`,
    detail,
  )
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new OpenAICompatibleError(
      response.status,
      'LLM response was not valid JSON',
    )
  }
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

function parseArguments(raw: string): unknown {
  const text = raw.trim()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return raw
  }
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
