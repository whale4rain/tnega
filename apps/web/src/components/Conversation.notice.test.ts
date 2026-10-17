// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, streamRun } from '../lib/api'
import type { SessionDetail } from '../lib/types'
import { Conversation } from './Conversation'

vi.mock('../lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  streamRun: vi.fn(),
}))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

const STEERING = 'Steering sent. The agent will read it at the next step.'

function detail(running: boolean): SessionDetail {
  return {
    summary: { id: 'session', title: 'Test session', workspace: '/work', createdAt: 1, updatedAt: 1, eventCount: 0 },
    events: [], context: { tokens: 0, limit: 0, ratio: 0 },
    metrics: { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, running,
  }
}

it('dismisses the steering confirmation instead of leaving it under the transcript', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.spyOn(api, 'session').mockResolvedValue(detail(true))
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  vi.spyOn(api, 'steer').mockResolvedValue({ accepted: true })
  vi.mocked(streamRun).mockImplementation(() => new Promise(() => {}))
  const view = render(createElement(Conversation, {
    workspace: '/work', sessionId: 'session', config: undefined,
    draftSettings: { agentType: 'general', mode: 'auto', permission: 'read-only', reasoningEffort: 'default' },
    onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
    onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(), onOpenFile: vi.fn(),
    sidebarOpen: true, onToggleSidebar: vi.fn(),
  }))
  await view.findByText('Test session')
  const input = view.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'change direction' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(await view.findByText(STEERING)).toBeTruthy()

  act(() => { vi.advanceTimersByTime(5000) })
  await waitFor(() => expect(view.queryByText(STEERING)).toBeNull())
})
