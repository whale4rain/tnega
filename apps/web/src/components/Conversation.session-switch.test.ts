// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, streamRun } from '../lib/api'
import type { SessionDetail, StreamEvent } from '../lib/types'
import { Conversation } from './Conversation'

vi.mock('../lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  streamRun: vi.fn(),
}))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const BANNER = 'This session is running elsewhere. Updates appear automatically.'

function detailFor(id: string, title: string, running = false, events: SessionDetail['events'] = []): SessionDetail {
  return {
    summary: { id, title, workspace: '/work', createdAt: 1, updatedAt: 1, eventCount: events.length },
    events, context: { tokens: 0, limit: 0, ratio: 0 },
    metrics: { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, running,
  }
}

const userEvent = (id: string, seq: number, content: string) => ({
  id, seq, ts: 1, type: 'user/message' as const, payload: { content },
})

function props(sessionId: string) {
  return {
    workspace: '/work', sessionId, config: undefined,
    draftSettings: { agentType: 'general' as const, mode: 'auto' as const, permission: 'read-only' as const, reasoningEffort: 'default' as const },
    onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
    onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(), onOpenFile: vi.fn(),
    sidebarOpen: true, onToggleSidebar: vi.fn(),
  }
}

/** Start one local run and leave its stream open. */
async function startRun(view: ReturnType<typeof render>): Promise<(event: StreamEvent) => void> {
  let emit: ((event: StreamEvent) => void) | undefined
  vi.mocked(streamRun).mockImplementation((_workspace, _id, _prompt, onEvent) => {
    emit = onEvent
    return new Promise<void>(() => {})
  })
  await waitFor(() => view.getByRole('textbox'))
  const input = view.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'first request' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(emit).toBeDefined())
  return emit!
}

it('does not carry a run from the session it started in into the session you switch to', async () => {
  vi.spyOn(api, 'session').mockImplementation(async (_workspace, id) =>
    id === 'b' ? detailFor('b', 'Session B', false, [userEvent('b-user', 2, 'hello from B')]) : detailFor('a', 'Session A'))
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const view = render(createElement(Conversation, props('a')))
  await view.findByText('Session A')
  const emit = await startRun(view)
  expect(view.getByRole('button', { name: 'Stop' })).toBeTruthy()

  view.rerender(createElement(Conversation, props('b')))
  await view.findByText('hello from B')
  // The run belongs to session A: session B is not running, so it is neither
  // stoppable nor a place for A's stream frames to land.
  expect(view.queryByRole('button', { name: 'Stop' })).toBeNull()
  expect(view.queryByText(BANNER)).toBeNull()
  emit({ type: 'message_start', id: 'live-1' })
  emit({ type: 'message_delta', id: 'live-1', delta: 'leaked into B' })
  await waitFor(() => expect(view.queryByText('leaked into B')).toBeNull())
})

it('shows the live stop control again when you come back to the running session', async () => {
  const seen: string[] = []
  vi.spyOn(api, 'session').mockImplementation(async (_workspace, id) => {
    seen.push(id)
    return id === 'b' ? detailFor('b', 'Session B', false, [userEvent('b-user', 2, 'hello from B')]) : detailFor('a', 'Session A')
  })
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const view = render(createElement(Conversation, props('a')))
  await view.findByText('Session A')
  const emit = await startRun(view)
  emit({ type: 'message_start', id: 'live-2' })

  view.rerender(createElement(Conversation, props('b')))
  await view.findByText('hello from B')
  view.rerender(createElement(Conversation, props('a')))
  // Coming back reloads A's durable history and keeps the stream live.
  await waitFor(() => expect(seen.at(-1)).toBe('a'))
  expect(view.getByRole('button', { name: 'Stop' })).toBeTruthy()
  await waitFor(() => expect(view.queryByText('hello from B')).toBeNull())
})

it('does not report an idle session as running elsewhere', async () => {
  vi.spyOn(api, 'session').mockImplementation(async (_workspace, id) =>
    id === 'b' ? detailFor('b', 'Session B', false, [userEvent('b-user', 2, 'hello from B')]) : detailFor('a', 'Session A'))
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const view = render(createElement(Conversation, props('a')))
  await view.findByText('Session A')
  view.rerender(createElement(Conversation, props('b')))
  await view.findByText('hello from B')
  expect(view.queryByText(BANNER)).toBeNull()
})

it('keeps the transcript on screen when a run started elsewhere finishes', async () => {
  vi.spyOn(api, 'session').mockImplementation(async (_workspace, id) =>
    id === 'b'
      ? detailFor('b', 'Session B', false, [userEvent('b-user', 2, 'hello from B')])
      : detailFor('a', 'Session A', false, [userEvent('a-user', 1, 'hello from A')]))
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  let finish: (() => void) | undefined
  vi.mocked(streamRun).mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  const view = render(createElement(Conversation, props('a')))
  await view.findByText('Session A')
  await waitFor(() => view.getByRole('textbox'))
  const input = view.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'first request' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(finish).toBeDefined())

  view.rerender(createElement(Conversation, props('b')))
  await view.findByText('hello from B')
  finish!()
  // A's reload must not overwrite B, which the user is reading.
  await waitFor(() => expect(view.getByText('hello from B')).toBeTruthy())
  expect(view.queryByText('hello from A')).toBeNull()
  expect(view.queryByText(BANNER)).toBeNull()
  expect(view.queryByRole('button', { name: 'Stop' })).toBeNull()
})
