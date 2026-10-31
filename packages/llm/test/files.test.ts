import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import type { ModelAttachment, ModelMessage } from '@tnega/session'

import {
  anthropicMessagesAdapter,
  openaiCompatAdapter,
  openaiResponsesAdapter,
  prepareWireImages,
  resetImageFiles,
} from '../src/index.js'

type FetchMock = Mock<(...args: [unknown, RequestInit?]) => Promise<Response>>

const PNG: ModelAttachment = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }
const PNG2: ModelAttachment = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAA=' }

const conversation: ModelMessage[] = [
  { role: 'user', content: 'what is on screen?', attachments: [PNG] },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'computer_screenshot', arguments: {} }] },
  { role: 'tool', content: 'captured 1280x800', name: 'computer_screenshot', tool_call_id: 'call_1', attachments: [PNG] },
]

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** A Files API that names the file after the upload order, then whatever the caller replays. */
function uploadMock(uploads = new Map<string, number>()): FetchMock {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/files')) {
      const key = String(url)
      const next = (uploads.get(key) ?? 0) + 1
      uploads.set(key, next)
      return json({ id: `file-${next}`, object: 'file' })
    }
    return init?.method === 'POST' ? new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) : json({})
  }) as unknown as FetchMock
}

beforeEach(() => { resetImageFiles(); vi.unstubAllGlobals() })

describe('image files', () => {
  it('uploads each unique image once and references it by id, leaving no base64 in the body', async () => {
    const fetchMock = uploadMock()
    const wire = await prepareWireImages(conversation, { baseUrl: 'https://api.example.com', fetch: fetchMock })
    expect(wire.referenced).toBe(2)
    expect(wire.inline).toBe(0)
    expect(wire.fileId(PNG)).toBe('file-1')
    // The same bytes in two messages share one upload.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/files'))).toHaveLength(1)

    const again = await prepareWireImages(conversation, { baseUrl: 'https://api.example.com', fetch: fetchMock })
    expect(again.fileId(PNG)).toBe('file-1')
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/files'))).toHaveLength(1)

    const other = await prepareWireImages(
      [{ role: 'user', content: 'next frame', attachments: [PNG2] }],
      { baseUrl: 'https://api.example.com', fetch: fetchMock },
    )
    expect(other.fileId(PNG2)).toBe('file-2')
  })

  it('learns the purpose a route accepts, then reuses it', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/files')) {
        const form = init?.body as FormData
        const purpose = String(form.get('purpose'))
        calls.push(purpose)
        if (purpose === 'vision') {
          return new Response(JSON.stringify({ error: { message: "The 'vision' purpose is not supported. Supported purposes: [\"user_data\"]" } }), { status: 400 })
        }
        return json({ id: 'file-x' })
      }
      return json({})
    }) as unknown as FetchMock

    const wire = await prepareWireImages(conversation, { baseUrl: 'https://api.deepseek.com', fetch: fetchMock })
    expect(wire.referenced).toBe(2)
    expect(calls).toEqual(['vision', 'user_data'])
    // Second request goes straight to the accepted purpose.
    await prepareWireImages([{ role: 'user', content: 'again', attachments: [PNG2] }], { baseUrl: 'https://api.deepseek.com', fetch: fetchMock })
    expect(calls).toEqual(['vision', 'user_data', 'user_data'])
  })

  it('keeps images inline for a route with no Files API, and stops asking', async () => {
    let attempts = 0
    const fetchMock = vi.fn(async () => {
      attempts += 1
      return new Response('{"error":"not found"}', { status: 404 })
    }) as unknown as FetchMock
    const first = await prepareWireImages(conversation, { baseUrl: 'https://plain.example.com', fetch: fetchMock })
    expect(first.referenced).toBe(0)
    expect(first.inline).toBe(2)
    const second = await prepareWireImages(conversation, { baseUrl: 'https://plain.example.com', fetch: fetchMock })
    expect(second.inline).toBe(2)
    // One attempt per unique image, and none after the endpoint was marked unsupported.
    expect(attempts).toBe(1)
  })

  it('fails instead of falling back when files are required', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })) as unknown as FetchMock
    await expect(prepareWireImages(conversation, { baseUrl: 'https://api.example.com', filesApi: 'required', fetch: fetchMock }))
      .rejects.toThrow(/status 500/)
  })

  it('stays inline when files are off', async () => {
    const fetchMock = uploadMock()
    const wire = await prepareWireImages(conversation, { baseUrl: 'https://api.example.com', filesApi: 'off', fetch: fetchMock })
    expect(wire.referenced).toBe(0)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/files'))).toBe(false)
  })
})

describe('file references on the wire', () => {
  /** The provider request: the upload calls are the ones to `/files`. */
  const lastRequest = (fetchMock: FetchMock): RequestInit => {
    const calls = fetchMock.mock.calls.filter(([url]) => !String(url).endsWith('/files'))
    return calls.at(-1)![1]!
  }

  it('chat completions sends a file id part', async () => {
    const fetchMock = uploadMock()
    vi.stubGlobal('fetch', fetchMock)
    const adapter = openaiCompatAdapter({ baseUrl: 'https://api.example.com', model: 'deepseek-flash', fetch: fetchMock })
    // The reply body is irrelevant here; only the request matters.
    await adapter.complete(conversation, [], {}).catch(() => undefined)
    const body = String(lastRequest(fetchMock).body)
    expect(body).not.toContain('iVBORw0KGgo=')
    expect(body).toContain('"type":"file","file_id":"file-1"')
  })

  it('responses sends input_image with a file id', async () => {
    const fetchMock = uploadMock()
    vi.stubGlobal('fetch', fetchMock)
    const adapter = openaiResponsesAdapter({ baseUrl: 'https://api.example.com', model: 'gpt-6.1', fetch: fetchMock })
    await adapter.complete(conversation, [], {}).catch(() => undefined)
    const body = JSON.parse(String(lastRequest(fetchMock).body)) as { input: Array<{ content?: Array<Record<string, unknown>> }> }
    const parts = body.input.flatMap(item => item.content ?? [])
    expect(parts.filter(part => part.type === 'input_image')).toEqual([
      { type: 'input_image', file_id: 'file-1' },
      { type: 'input_image', file_id: 'file-1' },
    ])
  })

  it('anthropic sends a file source and asks for the files beta', async () => {
    const fetchMock = uploadMock()
    vi.stubGlobal('fetch', fetchMock)
    const adapter = anthropicMessagesAdapter({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-4-7', fetch: fetchMock })
    await adapter.complete(conversation, [], {}).catch(() => undefined)
    const init = lastRequest(fetchMock)
    const headers = init.headers as Record<string, string>
    expect(headers['anthropic-beta']).toBe('files-api-2025-04-14')
    expect(String(init.body)).toContain('"type":"file","file_id":"file-1"')
    expect(String(init.body)).not.toContain('iVBORw0KGgo=')
  })
})

describe('server-kept conversations', () => {
  function sse(events: unknown[]): Response {
    const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  function responsesMock(store: boolean, ids: string[]): FetchMock {
    let index = 0
    return vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/files')) return json({ id: 'file-1' })
      const id = ids[index] ?? `resp-${index}`
      index += 1
      return sse([
        { type: 'response.created', response: { id, model: 'm', store } },
        { type: 'response.output_text.delta', delta: 'ok' },
        { type: 'response.completed', response: { id, model: 'm', store, status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
      ])
    }) as unknown as FetchMock
  }

  const first: ModelMessage[] = [{ role: 'user', content: 'remember 42' }]
  const second: ModelMessage[] = [...first, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'what was it?' }]

  it('sends only the new turns once the provider keeps state', async () => {
    const fetchMock = responsesMock(true, ['resp-a', 'resp-b'])
    const adapter = openaiResponsesAdapter({ baseUrl: 'https://api.example.com', model: 'gpt-6.1', fetch: fetchMock }); vi.stubGlobal('fetch', fetchMock)
    await adapter.complete(first, [], {})
    await adapter.complete(second, [], {})

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(firstBody.store).toBe(true)
    expect(firstBody.previous_response_id).toBeUndefined()

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)) as Record<string, unknown> & { input: Array<{ role?: string }> }
    expect(secondBody.previous_response_id).toBe('resp-a')
    expect(secondBody.store).toBe(true)
    // Only the assistant turn and the new user turn travel; the first message is server-side now.
    expect(secondBody.input.map(item => item.role).filter(Boolean)).toEqual(['assistant', 'user'])
  })

  it('resends the whole conversation when the provider did not store it', async () => {
    const fetchMock = responsesMock(false, ['resp-a', 'resp-b'])
    const adapter = openaiResponsesAdapter({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', fetch: fetchMock }); vi.stubGlobal('fetch', fetchMock)
    await adapter.complete(first, [], {})
    await adapter.complete(second, [], {})
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)) as Record<string, unknown> & { input: Array<{ role?: string }> }
    expect(secondBody.previous_response_id).toBeUndefined()
    expect(secondBody.input.filter(item => item.role === 'user')).toHaveLength(2)
  })

  it('falls back to full history when the history is not a prefix any more', async () => {
    const fetchMock = responsesMock(true, ['resp-a', 'resp-b'])
    const adapter = openaiResponsesAdapter({ baseUrl: 'https://api.example.com', model: 'gpt-6.1', fetch: fetchMock }); vi.stubGlobal('fetch', fetchMock)
    await adapter.complete(first, [], {})
    // A compaction rewrote the first message.
    const rewritten: ModelMessage[] = [{ role: 'user', content: 'summary: user asked about 42' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'what was it?' }]
    await adapter.complete(rewritten, [], {})
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)) as Record<string, unknown>
    expect(secondBody.previous_response_id).toBeUndefined()
  })
})
