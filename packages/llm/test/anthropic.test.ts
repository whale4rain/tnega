import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import type { ModelMessage } from '@tnega/session'
import type { LLMStreamEvent } from '@tnega/agent'
import type { ToolDefinition } from '@tnega/tools'

import {
  DEFAULT_MODEL,
  anthropicMessagesAdapter,
  OpenAICompatibleError,
} from '../src/index.js'

type FetchMock = Mock<(...args: [unknown, RequestInit]) => Promise<Response>>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collectStream(
  adapter: ReturnType<typeof anthropicMessagesAdapter>,
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<LLMStreamEvent[]> {
  const stream = adapter.stream
  if (!stream) throw new Error('adapter does not expose stream')
  const events: LLMStreamEvent[] = []
  for await (const event of stream(
    messages,
    [],
    { ...(signal ? { signal } : {}) },
  )) {
    events.push(event)
  }
  return events
}

const addTool: ToolDefinition = {
  schema: {
    name: 'add',
    description: 'add two numbers',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
    },
  },
  execute: () => 3,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('anthropicMessagesAdapter', () => {
  it('maps system, user, assistant tool calls and tool results into Messages', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      id: 'msg_1',
      model: 'minimax-m3',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const messages: ModelMessage[] = [
      { role: 'system', content: 'be precise' },
      { role: 'user', content: '1+2?' },
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [{ id: 'toolu_1', name: 'add', arguments: { a: 1, b: 2 } }],
      },
      {
        role: 'tool',
        content: '3',
        name: 'add',
        tool_call_id: 'toolu_1',
      },
      { role: 'user', content: 'thanks' },
    ]
    const adapter = anthropicMessagesAdapter({
      apiKey: 'test-key',
      model: 'minimax-m3',
      baseUrl: 'https://opencode.ai/zen/go/v1/',
      temperature: 0.2,
      maxTokens: 256,
    })
    const completion = await adapter.complete(messages, [addTool], {})

    expect(completion).toEqual({ content: 'ok', finishReason: 'stop' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://opencode.ai/zen/go/v1/messages',
    )
    const init = fetchMock.mock.calls[0]![1]!
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('test-key')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(String(init.body)) as {
      model: string
      temperature: number
      max_tokens: number
      system: string
      messages: unknown[]
      tools: unknown[]
    }
    expect(body.model).toBe('minimax-m3')
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(256)
    expect(body.system).toBe('be precise')
    expect(body.messages).toEqual([
      { role: 'user', content: '1+2?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'add',
            input: { a: 1, b: 2 },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '3' },
        ],
      },
      { role: 'user', content: 'thanks' },
    ])
    expect(body.tools).toEqual([
      {
        name: 'add',
        description: 'add two numbers',
        input_schema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
          },
        },
      },
    ])
  })

  it('normalizes a base URL that already ends with /messages', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = anthropicMessagesAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://opencode.ai/zen/go/v1/messages',
    })
    await adapter.complete([{ role: 'user', content: 'hi' }], [], {})

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://opencode.ai/zen/go/v1/messages',
    )
  })

  it('uses the default model and max_tokens when not configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = anthropicMessagesAdapter({ apiKey: 'test-key' })
    await adapter.complete([{ role: 'user', content: 'hi' }], [], {})

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      model: string
      max_tokens: number
    }
    expect(body.model).toBe(DEFAULT_MODEL)
    expect(body.max_tokens).toBe(4096)
  })

  it('parses tool_use completions and marks tool errors', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      content: [
        { type: 'text', text: 'calling' },
        {
          type: 'tool_use',
          id: 'toolu_9',
          name: 'add',
          input: { a: 1, b: 2 },
        },
      ],
      stop_reason: 'tool_use',
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = anthropicMessagesAdapter({ apiKey: 'test-key' })
    const completion = await adapter.complete(
      [{ role: 'user', content: '1+2?' }],
      [addTool],
      {},
    )

    expect(completion).toEqual({
      content: 'calling',
      toolCalls: [
        { id: 'toolu_9', name: 'add', arguments: { a: 1, b: 2 } },
      ],
      finishReason: 'tool_calls',
    })
  })

  it('maps failed tool results to is_error', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = anthropicMessagesAdapter({ apiKey: 'test-key' })
    await adapter.complete(
      [
        {
          role: 'tool',
          content: 'boom',
          name: 'add',
          tool_call_id: 'toolu_1',
          toolError: { message: 'boom' },
        },
      ],
      [],
      {},
    )

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    expect(body.messages[0]!.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'boom',
      is_error: true,
    })
  })

  it('streams text deltas and maps stop reasons', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"minimax-m3"}}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hel"}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: content_block_stop\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ])) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = anthropicMessagesAdapter({ apiKey: 'test-key' })
    const events = await collectStream(adapter, [{ role: 'user', content: 'hi' }])

    expect(events).toEqual([
      { type: 'message_start', id: 'msg_1', model: 'minimax-m3' },
      { type: 'message_delta', id: 'msg_1', delta: 'hel' },
      { type: 'message_delta', id: 'msg_1', delta: 'lo' },
      { type: 'message_stop', id: 'msg_1', finishReason: 'stop' },
    ])
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      stream?: boolean
    }
    expect(body.stream).toBe(true)
  })

  it('streams split input_json_delta into tool start and end events', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"add","input":{}}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"1,\\"b\\":2}"}}\n\n',
      'event: content_block_stop\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ])) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = anthropicMessagesAdapter({ apiKey: 'test-key' })
    const events = await collectStream(adapter, [{ role: 'user', content: '1+2' }])

    expect(events).toEqual([
      { type: 'message_start', id: 'msg_1' },
      {
        type: 'toolcall_start',
        id: 'toolu_1',
        index: 0,
        name: 'add',
      },
      {
        type: 'toolcall_end',
        id: 'toolu_1',
        index: 0,
        name: 'add',
        arguments: { a: 1, b: 2 },
      },
      { type: 'message_stop', id: 'msg_1', finishReason: 'tool_calls' },
    ])
  })

  it('retries 500 and 429 responses before succeeding', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({
        content: [{ type: 'text', text: 'recovered' }],
        stop_reason: 'end_turn',
      })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = anthropicMessagesAdapter({
      apiKey: 'test-key',
      maxRetries: 2,
      retryDelayMs: 1,
    })
    const completion = await adapter.complete(
      [{ role: 'user', content: 'hi' }],
      [],
      {},
    )

    expect(completion.content).toBe('recovered')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries a transient network error and a timeout', async () => {
    let attempts = 0
    const fetchMock = vi.fn((_url: unknown, init: RequestInit) => {
      attempts += 1
      if (attempts === 1) {
        return Promise.reject(new Error('ECONNRESET'))
      }
      if (attempts === 2) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('timed out'), { name: 'AbortError' }))
          })
        })
      }
      return Promise.resolve(jsonResponse({
        content: [{ type: 'text', text: 'finally' }],
        stop_reason: 'end_turn',
      }))
    }) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = anthropicMessagesAdapter({
      apiKey: 'test-key',
      timeoutMs: 10,
      maxRetries: 2,
      retryDelayMs: 1,
    })
    const completion = await adapter.complete(
      [{ role: 'user', content: 'hi' }],
      [],
      {},
    )

    expect(completion.content).toBe('finally')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry when the caller aborts', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn((_url: unknown, init: RequestInit) => {
      controller.abort(new Error('caller aborted'))
      expect(init.signal?.aborted).toBe(true)
      return Promise.reject(
        Object.assign(new Error('caller aborted'), { name: 'AbortError' }),
      )
    }) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = anthropicMessagesAdapter({
      apiKey: 'test-key',
      maxRetries: 3,
      retryDelayMs: 1,
    })
    await expect(adapter.complete(
      [{ role: 'user', content: 'go' }],
      [],
      { signal: controller.signal },
    )).rejects.toMatchObject({
      name: 'OpenAICompatibleError',
      status: 0,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('redacts the API key from error details', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        type: 'error',
        error: { message: 'invalid x-api-key: sk-secret-key' },
      }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = anthropicMessagesAdapter({ apiKey: 'sk-secret-key' })
    await expect(adapter.complete([{ role: 'user', content: 'hi' }], [], {}))
      .rejects
      .toMatchObject({
        name: 'OpenAICompatibleError',
        status: 401,
      })
    const error = await adapter.complete(
      [{ role: 'user', content: 'hi' }],
      [],
      {},
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OpenAICompatibleError)
    const detail = (error as OpenAICompatibleError).detail ?? ''
    expect(detail).not.toContain('sk-secret-key')
    expect(detail).toContain('[redacted]')
  })
})
