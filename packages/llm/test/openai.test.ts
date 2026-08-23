import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import type { ModelMessage } from '@tnega/session'
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

  it('forwards the abort signal to fetch', async () => {
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
    expect(init.signal).toBe(controller.signal)
  })

  it('wraps non-ok responses without exposing the API key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'invalid api key' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )))

    const adapter = openaiCompatAdapter({ apiKey: 'should-not-leak' })
    await expect(adapter.complete([{ role: 'user', content: 'hi' }], [], {}))
      .rejects
      .toMatchObject({
        name: 'OpenAICompatibleError',
        status: 401,
        detail: '{"error":{"message":"invalid api key"}}',
      })
  })

  it('wraps transport failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('socket hang up')
    }))

    const adapter = openaiCompatAdapter({ apiKey: 'test-key' })
    await expect(adapter.complete([{ role: 'user', content: 'hi' }], [], {}))
      .rejects
      .toThrow('LLM request failed: socket hang up')
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
