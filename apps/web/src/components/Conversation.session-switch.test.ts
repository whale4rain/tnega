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

function props(sessionId: string | undefined) {
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

it('starts a new session empty instead of inheriting the run you left behind', async () => {
  vi.spyOn(api, 'session').mockImplementation(async (_workspace, id) => detailFor(id, 'Session A'))
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const view = render(createElement(Conversation, props('a')))
  await view.findByText('Session A')
  const emit = await startRun(view)
  emit({ type: 'message_start', id: 'live-3' })
  emit({ type: 'message_delta', id: 'live-3', delta: 'answer in A' })
  await waitFor(() => expect(view.getByText('answer in A')).toBeTruthy())

  // A new session has no id yet: it is an empty draft, not a place for A's run.
  view.rerender(createElement(Conversation, props(undefined)))
  await waitFor(() => expect(view.queryByText('answer in A')).toBeNull())
  emit({ type: 'message_start', id: 'live-4' })
  emit({ type: 'message_delta', id: 'live-4', delta: 'leaked into the new session' })
  emit({ type: 'approval/request', id: 'approval-1', tool: 'shell', input: '{}' })
  emit({ type: 'plan/start' })
  emit({ type: 'plan/items', plan: { items: [{ id: 'step', title: 'Leaked plan step', status: 'pending' }], status: 'pending' } })
  await waitFor(() => expect(view.queryByText('leaked into the new session')).toBeNull())
  expect(view.queryByText('Leaked plan step')).toBeNull()
  expect(view.queryByLabelText('Permission request')).toBeNull()
  // Nor is the run stoppable from a session it does not belong to.
  expect(view.queryByRole('button', { name: 'Stop' })).toBeNull()
})

it('shows no reply from a run you left when a new session starts a run of its own', async () => {
  vi.spyOn(api, 'session').mockImplementation(async (_workspace, id) => detailFor(id, `Session ${id.toUpperCase()}`))
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const emitters = new Map<string, (event: StreamEvent) => void>()
  vi.mocked(streamRun).mockImplementation((_workspace, id, _prompt, onEvent) => {
    emitters.set(id, onEvent)
    return new Promise<void>(() => {})
  })
  const created = { id: 'b', title: 'New session', workspace: '/work', createdAt: 2, updatedAt: 2, eventCount: 1 }
  vi.spyOn(api, 'createSession').mockResolvedValue({ session: created })
  vi.spyOn(api, 'patchSession').mockResolvedValue({ summary: created })

  const view = render(createElement(Conversation, props('a')))
  await view.findByText('Session A')
  await waitFor(() => view.getByRole('textbox'))
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'first request' } })
  fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' })
  await waitFor(() => expect(emitters.has('a')).toBe(true))

  // The user leaves A's live run for a new session and sends there.
  view.rerender(createElement(Conversation, props(undefined)))
  await waitFor(() => view.getByRole('textbox'))
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'second request' } })
  fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' })
  await waitFor(() => expect(emitters.has('b')).toBe(true))
  view.rerender(createElement(Conversation, props('b')))
  await waitFor(() => expect(view.queryByText('first request')).toBeNull())

  // A's run is still streaming: its frames belong to A, not to the session on screen.
  emitters.get('a')!({ type: 'message_start', id: 'a-live' })
  emitters.get('a')!({ type: 'message_delta', id: 'a-live', delta: 'reply from A' })
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(view.queryByText('reply from A')).toBeNull()

  emitters.get('b')!({ type: 'message_start', id: 'b-live' })
  emitters.get('b')!({ type: 'message_delta', id: 'b-live', delta: 'reply from B' })
  await waitFor(() => expect(view.getByText('reply from B')).toBeTruthy())
  expect(view.queryByText('reply from A')).toBeNull()
})
