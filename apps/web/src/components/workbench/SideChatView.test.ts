// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SideChatView } from './SideChatView'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** A server that answers every side question with `reply` as two frames, and records the requests. */
function serve(reply: string) {
  const requests: Array<{ url: string; body: { messages: Array<{ role: string; content: string }>; session?: string } }> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) })
    const frames = [
      { type: 'side/delta', text: reply.slice(0, 4) },
      { type: 'side/delta', text: reply.slice(4) },
      { type: 'side/done', finishReason: 'stop' },
    ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('')
    return new Response(frames, { headers: { 'content-type': 'text/event-stream' } })
  })
  return requests
}

it('asks a /btw question about its session and keeps the turns for the next one', async () => {
  const requests = serve('It is editing parse.ts.')
  const view = render(createElement(SideChatView, {
    workspace: '/work',
    ask: { question: 'which file?', session: { id: 's1', title: 'Fix parser' }, nonce: 1 },
    visible: true,
  }))
  expect(await view.findByText('It is editing parse.ts.')).toBeTruthy()
  expect(requests[0]?.url).toBe('/api/side-chat?workspace=%2Fwork')
  expect(requests[0]?.body).toEqual({ session: 's1', messages: [{ role: 'user', content: 'which file?' }] })
  expect(view.getByRole('button', { name: 'About Fix parser. Click to stop' }).getAttribute('aria-pressed')).toBe('true')

  const input = view.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'and why?' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]?.body.messages).toEqual([
    { role: 'user', content: 'which file?' },
    { role: 'assistant', content: 'It is editing parse.ts.' },
    { role: 'user', content: 'and why?' },
  ])

  // The same ask does not ask again on a later render.
  view.rerender(createElement(SideChatView, {
    workspace: '/work',
    ask: { question: 'which file?', session: { id: 's1', title: 'Fix parser' }, nonce: 1 },
    visible: true,
  }))
  await vi.waitFor(() => expect(view.getAllByText('It is editing parse.ts.')).toHaveLength(2))
  expect(requests).toHaveLength(2)

  fireEvent.click(view.getByRole('button', { name: 'Start over' }))
  expect(view.queryByText('It is editing parse.ts.')).toBeNull()
})

it('is a plain chat until you let it read the open session', async () => {
  const requests = serve('Hello there.')
  const view = render(createElement(SideChatView, { workspace: '/work', current: { id: 's2', title: 'Release notes' }, visible: true }))
  expect(view.getByText('Ask anything on the side. Nothing here is saved.')).toBeTruthy()
  const toggle = view.getByRole('button', { name: 'Ask about Release notes' })
  expect(toggle.getAttribute('aria-pressed')).toBe('false')

  const input = view.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'hi' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(await view.findByText('Hello there.')).toBeTruthy()
  expect(requests[0]?.body).toEqual({ messages: [{ role: 'user', content: 'hi' }] })

  fireEvent.click(toggle)
  fireEvent.change(input, { target: { value: 'what is it about?' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]?.body.session).toBe('s2')
})

it('shows a failed answer in the chat', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ error: 'API key is not configured' }, { status: 400 }))
  const view = render(createElement(SideChatView, { workspace: '/work', ask: { question: 'hi', nonce: 1 }, visible: true }))
  expect((await view.findByRole('alert')).textContent).toBe('API key is not configured')
})
