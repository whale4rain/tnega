import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import type { ModelMessage } from '@tnega/session'
import type { LLMStreamEvent } from '@tnega/agent'
import type { ToolDefinition } from '@tnega/tools'

import {
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_OPENCODE_GO_BASE_URL,
  listModels,
  openaiCompatAdapter,
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
  adapter: ReturnType<typeof openaiCompatAdapter>,
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = []
  const stream = adapter.stream
  if (!stream) throw new Error('adapter does not expose stream')
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
  schema: { name: 'add', description: 'add two numbers' },
  execute: () => 3,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openaiCompatAdapter', () => {
  it('sends messages and tools, then maps a plain completion', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      id: 'chatcmpl-1',
      model: 'deepseek-v4-flash',
      choices: [
        {
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        },
      ],
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const messages: ModelMessage[] = [
      { role: 'user', content: 'say hello' },
      {
        role: 'tool',
        content: '3',
        name: 'add',
        tool_call_id: 'c1',
      },
    ]
    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      maxTokens: 16,
      temperature: 0,
    })
    const completion = await adapter.complete(messages, [addTool], {})

    expect(completion).toEqual({ content: 'hello', finishReason: 'stop' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `${DEFAULT_OPENCODE_GO_BASE_URL}/chat/completions`,
    )
    const init = fetchMock.mock.calls[0]![1]!
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key')
    const body = JSON.parse(String(init.body)) as {
      model: string
      temperature: number
      max_tokens: number
      messages: Array<Record<string, unknown>>
      tools: unknown[]
    }
    expect(body.model).toBe('deepseek-v4-flash')
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBe(16)
    expect(body.messages).toEqual([
      { role: 'user', content: 'say hello' },
      {
        role: 'tool',
        content: '3',
        name: 'add',
        tool_call_id: 'c1',
      },
    ])
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'add',
          description: 'add two numbers',
          parameters: { type: 'object', properties: {} },
        },
      },
    ])
  })

  it('parses tool calls and JSON arguments, preserving invalid JSON', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'add', arguments: '{"a":1,"b":2}' },
              },
              {
                id: 'c2',
                type: 'function',
                function: { name: 'echo', arguments: 'not-json' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({ apiKey: 'test-key' })
    const completion = await adapter.complete(
      [{ role: 'user', content: 'call tools' }],
      [addTool],
      {},
    )

    expect(completion).toEqual({
      content: '',
      toolCalls: [
        { id: 'c1', name: 'add', arguments: { a: 1, b: 2 } },
        { id: 'c2', name: 'echo', arguments: 'not-json' },
      ],
      finishReason: 'tool_calls',
    })

    const init = fetchMock.mock.calls[0]![1]!
    const body = JSON.parse(String(init.body)) as { messages: unknown[] }
    expect(body.messages[0]).toEqual({ role: 'user', content: 'call tools' })
  })

  it('passes a combined timeout and caller signal to fetch', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({ apiKey: 'test-key' })
    await adapter.complete(
      [{ role: 'user', content: 'go' }],
      [],
      { signal: controller.signal },
    )
    const init = fetchMock.mock.calls[0]![1]!
    expect(init.signal).toBeDefined()
    expect(init.signal).not.toBe(controller.signal)
  })

  it('does not retry when the caller aborts', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn((_url: unknown, init: RequestInit) => {
      controller.abort(new Error('caller aborted'))
      const signal = init.signal
      expect(signal?.aborted).toBe(true)
      return Promise.reject(
        Object.assign(new Error('caller aborted'), { name: 'AbortError' }),
      )
    }) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
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

  it('wraps non-ok responses without exposing the API key', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'invalid api key' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({ apiKey: 'should-not-leak' })
    await expect(adapter.complete([{ role: 'user', content: 'hi' }], [], {}))
      .rejects
      .toMatchObject({
        name: 'OpenAICompatibleError',
        status: 401,
        detail: '{"error":{"message":"invalid api key"}}',
      })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('wraps transport failures', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      retryDelayMs: 1,
    })
    await expect(adapter.complete([{ role: 'user', content: 'hi' }], [], {}))
      .rejects
      .toThrow('LLM request failed: socket hang up')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries a 500 response and then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }],
      })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      maxRetries: 2,
      retryDelayMs: 1,
    })
    const completion = await adapter.complete(
      [{ role: 'user', content: 'hi' }],
      [],
      {},
    )

    expect(completion).toEqual({ content: 'recovered', finishReason: 'stop' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries a 429 response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: 'slow down' }, finish_reason: 'stop' }],
      })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      maxRetries: 1,
      retryDelayMs: 1,
    })
    const completion = await adapter.complete(
      [{ role: 'user', content: 'hi' }],
      [],
      {},
    )

    expect(completion.content).toBe('slow down')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a transient network error', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: 'back online' }, finish_reason: 'stop' }],
      })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      maxRetries: 1,
      retryDelayMs: 1,
    })
    const completion = await adapter.complete(
      [{ role: 'user', content: 'hi' }],
      [],
      {},
    )

    expect(completion.content).toBe('back online')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('exhausts retries and surfaces the final status', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 500)) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      maxRetries: 2,
      retryDelayMs: 1,
    })
    await expect(adapter.complete([{ role: 'user', content: 'hi' }], [], {}))
      .rejects
      .toMatchObject({
        name: 'OpenAICompatibleError',
        status: 500,
      })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('honors maxRetries 0', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 500)) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      maxRetries: 0,
      retryDelayMs: 1,
    })
    await expect(adapter.complete([{ role: 'user', content: 'hi' }], [], {}))
      .rejects
      .toMatchObject({ status: 500 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails with a timeout error when the timeout is hit', async () => {
    const fetchMock = vi.fn((_url: unknown, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('timed out'), { name: 'AbortError' }))
        })
      })
    }) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      timeoutMs: 10,
      maxRetries: 0,
    })
    await expect(adapter.complete([{ role: 'user', content: 'hi' }], [], {}))
      .rejects
      .toMatchObject({
        name: 'OpenAICompatibleError',
        status: 0,
      })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a timeout and then succeeds', async () => {
    let attempts = 0
    const fetchMock = vi.fn((_url: unknown, init: RequestInit) => {
      attempts += 1
      if (attempts === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('timed out'), { name: 'AbortError' }))
          })
        })
      }
      return Promise.resolve(jsonResponse({
        choices: [{ message: { content: 'finally' }, finish_reason: 'stop' }],
      }))
    }) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      timeoutMs: 10,
      maxRetries: 1,
      retryDelayMs: 1,
    })
    const completion = await adapter.complete(
      [{ role: 'user', content: 'hi' }],
      [],
      {},
    )

    expect(completion.content).toBe('finally')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses sensible defaults for model and base URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({ apiKey: 'test-key' })
    await adapter.complete([{ role: 'user', content: 'hi' }], [], {})

    const url = String(fetchMock.mock.calls[0]![0])
    expect(url).toBe(`${DEFAULT_OPENCODE_GO_BASE_URL}/chat/completions`)
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      model: string
    }
    expect(body.model).toBe(DEFAULT_DEEPSEEK_MODEL)
  })

  it('streams content deltas and a final stop event', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'data: {"id":"m1","model":"deepseek-v4-flash","choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({ apiKey: 'test-key' })
    const events = await collectStream(adapter, [{ role: 'user', content: 'hi' }])

    expect(events).toEqual([
      { type: 'message_start', id: 'm1', model: 'deepseek-v4-flash' },
      { type: 'message_delta', id: 'm1', delta: 'hel' },
      { type: 'message_delta', id: 'm1', delta: 'lo' },
      { type: 'message_stop', id: 'm1', finishReason: 'stop' },
    ])
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      stream?: boolean
    }
    expect(body.stream).toBe(true)
  })

  it('streams split tool call deltas into start and end events', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"add","arguments":"{\\"a\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1,\\"b\\":2}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({ apiKey: 'test-key' })
    const events = await collectStream(adapter, [{ role: 'user', content: '1+2' }])

    expect(events).toEqual([
      { type: 'message_start', id: expect.any(String) },
      {
        type: 'toolcall_start',
        id: 'c1',
        index: 0,
        name: 'add',
      },
      {
        type: 'toolcall_end',
        id: 'c1',
        index: 0,
        name: 'add',
        arguments: { a: 1, b: 2 },
      },
      { type: 'message_stop', id: expect.any(String), finishReason: 'tool_calls' },
    ])
  })

  it('retries a transient status before emitting any event', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([], 500))
      .mockResolvedValueOnce(sseResponse([
        'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n',
        'data: [DONE]\n\n',
      ])) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      maxRetries: 1,
      retryDelayMs: 1,
    })
    const events = await collectStream(adapter, [{ role: 'user', content: 'hi' }])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events[1]).toMatchObject({ type: 'message_delta', delta: 'recovered' })
  })

  it('does not retry after events were emitted', async () => {
    const encoder = new TextEncoder()
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        ))
      },
      pull(controller) {
        controller.error(new Error('connection reset'))
      },
    })
    const fetchMock = vi.fn(async () => new Response(failing, {
      headers: { 'content-type': 'text/event-stream' },
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      maxRetries: 2,
      retryDelayMs: 1,
    })
    await expect(
      collectStream(adapter, [{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('LLM stream failed: connection reset')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts without retry when the caller cancels', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn((_url: unknown, init: RequestInit) => {
      controller.abort(new Error('cancelled'))
      const signal = init.signal
      expect(signal?.aborted).toBe(true)
      return Promise.reject(
        Object.assign(new Error('cancelled'), { name: 'AbortError' }),
      )
    }) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const adapter = openaiCompatAdapter({
      apiKey: 'test-key',
      maxRetries: 3,
      retryDelayMs: 1,
    })
    await expect(
      collectStream(adapter, [{ role: 'user', content: 'go' }], controller.signal),
    ).rejects.toMatchObject({ name: 'OpenAICompatibleError', status: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('listModels', () => {
  it('returns model ids from the OpenAI compatible models endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }],
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const models = await listModels({ apiKey: 'test-key' })
    expect(models).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `${DEFAULT_OPENCODE_GO_BASE_URL}/models`,
    )
  })

  it('throws OpenAICompatibleError on a bad model response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)))
    await expect(listModels({ apiKey: 'test-key' })).rejects.toBeInstanceOf(
      OpenAICompatibleError,
    )
  })
})
