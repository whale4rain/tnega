// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, streamRun } from '../lib/api'
import { PROCESS_VIEW_KEY } from '../lib/process-view'
import type { SessionDetail } from '../lib/types'
import { Conversation } from './Conversation'

vi.mock('../lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  streamRun: vi.fn(),
}))
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

function mount() {
  const detail: SessionDetail = {
    summary: { id: 'session', title: 'Test session', workspace: '/work', createdAt: 1, updatedAt: 1, eventCount: 0 },
    events: [], context: { tokens: 0, limit: 0, ratio: 0 },
    metrics: { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, running: false,
  }
  vi.spyOn(api, 'session').mockResolvedValue(detail)
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  vi.mocked(streamRun).mockImplementation((_workspace, _id, _prompt, onEvent) => {
    onEvent({ type: 'message_start', id: 'live' })
    onEvent({ type: 'message_delta', id: 'live', delta: 'Reading the sources first.' })
    return new Promise(() => {})
  })
  return render(createElement(Conversation, {
    workspace: '/work', sessionId: 'session', config: undefined,
    draftSettings: { agentType: 'general', mode: 'auto', permission: 'read-only', approvalMode: 'manual', reasoningEffort: 'default' },
    onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
    onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(), onOpenFile: vi.fn(),
    sidebarOpen: true, onToggleSidebar: vi.fn(),
  }))
}

it('offers the switch at the foot of the streaming reply and keeps the choice', async () => {
  const view = mount()
  await view.findByText('Test session')
  expect(view.queryByRole('button', { name: /^Process output/ })).toBeNull()
  const input = view.getByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: 'start' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  // Default: the process streams in as it happens.
  expect(await view.findByText('Reading the sources first.')).toBeTruthy()
  const turn = view.container.querySelector('.agent-turn.is-live')!
  const chip = view.getByRole('button', { name: 'Process output: Steps' })
  // It belongs to the streaming turn, not to the composer's dock.
  expect(turn.contains(chip)).toBe(true)
  expect(view.container.querySelector('.conv-dock')!.contains(chip)).toBe(false)
  fireEvent.click(chip)
  fireEvent.click(view.getByRole('option', { name: /Answer only/ }))
  await waitFor(() => expect(view.queryByText('Reading the sources first.')).toBeNull())
  expect(view.getByRole('button', { name: 'Process output: Answer only' })).toBeTruthy()
  expect(localStorage.getItem(PROCESS_VIEW_KEY)).toBe('answer')
})
