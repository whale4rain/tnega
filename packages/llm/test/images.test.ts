import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import type { ModelAttachment, ModelMessage } from '@tnega/session'

import {
  anthropicMessagesAdapter,
  modelCapabilities,
  openaiCompatAdapter,
  prepareImages,
  supportsVision,
} from '../src/index.js'

type FetchMock = Mock<(...args: [unknown, RequestInit]) => Promise<Response>>

const PNG: ModelAttachment = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }
const JPEG: ModelAttachment = { type: 'image', mediaType: 'image/jpeg', data: '/9j/4AAQ' }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function requestBody(fetchMock: FetchMock): { messages: Array<Record<string, unknown>> } {
  return JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { messages: Array<Record<string, unknown>> }
}

const conversation: ModelMessage[] = [
  { role: 'user', content: 'what is on screen?', attachments: [PNG] },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', name: 'browser_screenshot', arguments: {} }],
  },
  { role: 'tool', content: 'captured 1280x800', name: 'browser_screenshot', tool_call_id: 'call_1', attachments: [JPEG] },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('image capability', () => {
  it('recognises vision model families and honours a configured override', () => {
    expect(supportsVision('claude-sonnet-4-6')).toBe(true)
    expect(supportsVision('gpt-4o-mini')).toBe(true)
    expect(supportsVision('qwen2.5-vl-72b')).toBe(true)
    expect(supportsVision('deepseek-v4-flash')).toBe(false)
    expect(modelCapabilities('deepseek-v4-flash').vision).toBe(false)
    expect(modelCapabilities('deepseek-v4-flash', 'openai', undefined, true).vision).toBe(true)
  })
})

describe('prepareImages', () => {
  it('keeps the newest images within budget and notes the dropped ones', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'first', attachments: [PNG, PNG] },
      { role: 'user', content: 'second', attachments: [JPEG] },
    ]
    const prepared = prepareImages(messages, { vision: true, maxImages: 2 })
    expect(prepared[1]!.attachments).toEqual([JPEG])
    expect(prepared[0]!.attachments).toEqual([PNG])
    expect(prepared[0]!.content).toBe('first\n[1 image omitted: older images are dropped to bound context]')
    // The caller's messages, which mirror the Session, are not mutated.
    expect(messages[0]!.attachments).toHaveLength(2)
  })

  it('replaces every image with a note for a text-only model', () => {
    const prepared = prepareImages([{ role: 'user', content: '', attachments: [PNG] }], { model: 'deepseek-v4-flash' })
    expect(prepared[0]).toEqual({ role: 'user', content: '[1 image omitted: this model does not accept images]' })
  })
})

describe('openaiCompatAdapter images', () => {
  it('sends user images as content parts and tool images as a following user message', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'a login form' }, finish_reason: 'stop' }],
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    await openaiCompatAdapter({ apiKey: 'k', model: 'gpt-4o' }).complete(conversation, [], {})

    const { messages } = requestBody(fetchMock)
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is on screen?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.data}` } },
      ],
    })
    expect(messages[2]).toMatchObject({ role: 'tool', content: 'captured 1280x800', tool_call_id: 'call_1' })
    expect(messages[3]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Images returned by the tool calls above:' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG.data}` } },
      ],
    })
  })

  it('sends plain text to a text-only model', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    await openaiCompatAdapter({ apiKey: 'k', model: 'deepseek-v4-flash' }).complete(conversation, [], {})

    const { messages } = requestBody(fetchMock)
    expect(messages).toHaveLength(3)
    expect(messages[0]!.content).toBe('what is on screen?\n[1 image omitted: this model does not accept images]')
    expect(messages[2]!.content).toBe('captured 1280x800\n[1 image omitted: this model does not accept images]')
  })
})

describe('anthropicMessagesAdapter images', () => {
  it('sends base64 image blocks in user turns and inside tool results', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      id: 'msg_1',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    })) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    await anthropicMessagesAdapter({ apiKey: 'k', model: 'claude-sonnet-4-6' }).complete(conversation, [], {})

    const { messages } = requestBody(fetchMock)
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.data } },
        { type: 'text', text: 'what is on screen?' },
      ],
    })
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [
          { type: 'text', text: 'captured 1280x800' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG.data } },
        ],
      }],
    })
  })
})
