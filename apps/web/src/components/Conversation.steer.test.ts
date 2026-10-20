// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, streamRun } from '../lib/api'
import type { SessionDetail } from '../lib/types'
import { Conversation } from './Conversation'

vi.mock('../lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  streamRun: vi.fn(),
}))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(streamRun).mockReset() })

function detail(running: boolean): SessionDetail {
  return {
    summary: { id: 'session', title: 'Test session', workspace: '/work', createdAt: 1, updatedAt: 1, eventCount: 0 },
    events: [], context: { tokens: 0, limit: 0, ratio: 0 },
    metrics: { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, running,
  }
}

function mount() {
  return render(createElement(Conversation, {
    workspace: '/work', sessionId: 'session', config: undefined,
    draftSettings: { agentType: 'general', mode: 'auto', permission: 'read-only', reasoningEffort: 'default' },
    onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
    onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(), onOpenFile: vi.fn(),
    sidebarOpen: true, onToggleSidebar: vi.fn(),
  }))
}

function type(view: ReturnType<typeof mount>, text: string, ctrlKey = false) {
  const input = view.getByRole('textbox')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey })
}

it.each([true, false])('queues a message sent while running, and steers it on request (remote=%s)', async remote => {
  vi.spyOn(api, 'session').mockResolvedValue(detail(remote))
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const steer = vi.spyOn(api, 'steer').mockResolvedValue({ accepted: true })
  const stop = vi.spyOn(api, 'stop').mockResolvedValue({ stopped: true })
  const stream = vi.mocked(streamRun).mockImplementation(() => new Promise(() => {}))
  const view = mount()
  await view.findByText('Test session')
  if (!remote) {
    type(view, 'first request')
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
  }
  type(view, 'change direction')
  const queued = await view.findByRole('region', { name: 'Queued messages' })
  expect(queued.textContent).toContain('change direction')
  expect(steer).not.toHaveBeenCalled()

  fireEvent.click(view.getByRole('button', { name: 'Steer now' }))
  await waitFor(() => expect(steer).toHaveBeenCalledWith('/work', 'session', 'change direction', []))
  expect(await view.findByText('Steering sent. The agent will read it at the next step.')).toBeTruthy()
  expect(view.queryByRole('region', { name: 'Queued messages' })).toBeNull()

  // Ctrl+Enter skips the queue.
  type(view, 'and check the docs', true)
  await waitFor(() => expect(steer).toHaveBeenCalledWith('/work', 'session', 'and check the docs', []))
  expect(view.queryByRole('region', { name: 'Queued messages' })).toBeNull()

  expect(stream).toHaveBeenCalledTimes(remote ? 0 : 1)
  expect(stop).not.toHaveBeenCalled()
  expect(view.getByRole('button', { name: 'Stop' })).toBeTruthy()
})

it('sends the queue as the next prompt once a run ends on its own', async () => {
  vi.spyOn(api, 'session').mockResolvedValue(detail(false))
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const steer = vi.spyOn(api, 'steer').mockResolvedValue({ accepted: true })
  let finish: () => void = () => {}
  const stream = vi.mocked(streamRun)
    .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    .mockImplementation(() => new Promise(() => {}))
  const view = mount()
  await view.findByText('Test session')
  type(view, 'first request')
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
  type(view, 'then run lint')
  type(view, 'and the tests')
  await view.findByText('and the tests')
  finish()
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(2))
  expect(stream.mock.calls[1]?.[2]).toBe('then run lint\n\nand the tests')
  expect(steer).not.toHaveBeenCalled()
  expect(view.queryByRole('region', { name: 'Queued messages' })).toBeNull()
})

it('keeps the queue waiting after a stop, and edits a message back into the box', async () => {
  vi.spyOn(api, 'session').mockResolvedValue(detail(false))
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  let finish: () => void = () => {}
  vi.spyOn(api, 'stop').mockImplementation(async () => { finish(); return { stopped: true } })
  const stream = vi.mocked(streamRun)
    .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    .mockImplementation(() => new Promise(() => {}))
  const view = mount()
  await view.findByText('Test session')
  type(view, 'first request')
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
  type(view, 'maybe later')
  await view.findByText('maybe later')
  fireEvent.click(view.getByRole('button', { name: 'Stop' }))
  expect(await view.findByText('Your queued messages are waiting: send, edit or remove them.')).toBeTruthy()
  expect(stream).toHaveBeenCalledTimes(1)
  const queued = view.getByRole('region', { name: 'Queued messages' })
  expect(queued.querySelector('button.button')?.textContent).toBe('Send')

  fireEvent.click(view.getByRole('button', { name: 'Edit queued message' }))
  await waitFor(() => expect((view.getByRole('textbox') as HTMLTextAreaElement).value).toContain('maybe later'))
  expect(view.queryByRole('region', { name: 'Queued messages' })).toBeNull()
})
