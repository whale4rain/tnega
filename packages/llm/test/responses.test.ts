import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLlmAdapter, openaiResponsesAdapter, toResponsesInput } from '../src/index.js'

afterEach(() => { vi.unstubAllGlobals() })

function sse(events: readonly unknown[]): Response {
  const body = events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const reply = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5-codex' } },
  { type: 'response.output_text.delta', delta: 'Reading ' },
  { type: 'response.output_text.delta', delta: 'it.' },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'read_file' } },
  { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' } },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 1230 } } },
]

describe('OpenAI Responses adapter', () => {
  it('sends the system prompt as instructions and the history as input items', () => {
    const { instructions, input } = toResponsesInput([
      { role: 'system', content: 'You are Tnega.' },
      { role: 'user', content: 'Fix a.ts' },
      { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { role: 'tool', content: 'export {}', tool_call_id: 'call_1' },
      { role: 'system', content: '[compressed conversation]\nsummary' },
    ])
    expect(instructions).toBe('You are Tnega.')
    expect(input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix a.ts' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'export {}' },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '[compressed conversation]\nsummary' }] },
    ])
  })

  it('streams text, tool calls and usage, with fresh headers per request', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => sse(reply))
    vi.stubGlobal('fetch', fetchMock)
    let token = 0
    const adapter = createLlmAdapter({
      protocol: 'responses', baseUrl: 'https://chatgpt.example/backend-api/codex', model: 'gpt-5-codex', reasoningEffort: 'medium',
      requestHeaders: () => ({ authorization: `Bearer t${++token}`, 'chatgpt-account-id': 'acct' }),
    })
    const events = []
    for await (const event of adapter.stream!([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], [
      { schema: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }, execute: () => '' },
    ], {})) events.push(event)
    expect(events.map(event => event.type)).toEqual(['message_start', 'message_delta', 'message_delta', 'toolcall_start', 'toolcall_end', 'message_stop'])
    expect(events.at(-2)).toMatchObject({ type: 'toolcall_end', id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } })
    expect(events.at(-1)).toMatchObject({ finishReason: 'tool_calls', usage: { promptTokens: 1200, cachedTokens: 1000, completionTokens: 30, reasoningTokens: 12 } })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://chatgpt.example/backend-api/codex/responses')
    expect(init.headers).toMatchObject({ authorization: 'Bearer t1', 'chatgpt-account-id': 'acct' })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'gpt-5-codex', instructions: 'SYS', stream: true, store: false, reasoning: { effort: 'medium' } })
    expect(body.tools).toEqual([{ type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false }])

    const completion = await adapter.complete([{ role: 'user', content: 'again' }], [], {})
    expect(completion).toMatchObject({ content: 'Reading it.', toolCalls: [{ id: 'call_1' }], finishReason: 'tool_calls' })
    expect((fetchMock.mock.calls[1]![1].headers as Record<string, string>).authorization).toBe('Bearer t2')
  })

  it('switches to the fallback instructions once when the endpoint rejects the system prompt', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return bodies.length === 1
        ? new Response(JSON.stringify({ detail: 'Instructions are not valid' }), { status: 400 })
        : sse(reply)
    }))
    const adapter = openaiResponsesAdapter({ baseUrl: 'https://x.example', model: 'm', fallbackInstructions: async () => 'CODEX PROMPT' })
    const completion = await adapter.complete([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], [], {})
    expect(completion.content).toBe('Reading it.')
    expect(bodies[1]).toMatchObject({ instructions: 'CODEX PROMPT' })
    expect(bodies[1]!.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'SYS' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ])
  })

  it('reports a failed response and a stream that ends early', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ type: 'response.failed', response: { error: { message: 'usage limit reached' } } }])))
    await expect(openaiResponsesAdapter({ model: 'm', maxRetries: 0 }).complete([{ role: 'user', content: 'hi' }], [], {}))
      .rejects.toThrow('LLM stream failed: usage limit reached')
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ type: 'response.output_text.delta', delta: 'half' }])))
    await expect(openaiResponsesAdapter({ model: 'm', maxRetries: 0 }).complete([{ role: 'user', content: 'hi' }], [], {}))
      .rejects.toThrow('ended before the response completed')
  })
})
