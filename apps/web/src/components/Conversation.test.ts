// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { SessionDetail, SessionEvent } from '../lib/types'
import { Conversation } from './Conversation'

vi.mock('./Composer', () => ({ Composer: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('loads the human transcript and collapses completed runs even when model surface is populated', async () => {
  const events: SessionEvent[] = [
    { id: 'start', seq: 1, ts: 1, type: 'turn/start', payload: { turn: 1 } },
    { id: 'user', seq: 2, ts: 2, type: 'user/message', payload: { content: 'Check the project' } },
    { id: 'process', seq: 3, ts: 3, type: 'assistant/message', payload: { content: 'Inspecting the project.' } },
    { id: 'answer', seq: 4, ts: 4, type: 'assistant/message', payload: { content: 'All checks passed.' } },
    { id: 'end', seq: 5, ts: 5, type: 'turn/end', payload: { turn: 1, finishReason: 'stop' } },
    { id: 'summary', seq: 6, ts: 6, type: 'meta', payload: { kind: 'run/summary', turn: 1, summary: 'All checks passed.', sourceMessageId: 'answer' } },
  ]
  const detail: SessionDetail = {
    summary: { id: 'session', title: 'Test session', workspace: '/work', createdAt: 1, updatedAt: 6, eventCount: 6 },
    events,
    surface: events.filter(event => event.type === 'user/message' || event.type === 'assistant/message'),
    context: { tokens: 0, limit: 0, ratio: 0 },
    metrics: { responses: 2, promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    running: false,
  }
  vi.spyOn(api, 'session').mockResolvedValue(detail)
  const view = render(createElement(Conversation, {
    workspace: '/work', sessionId: 'session', config: undefined,
    draftSettings: { agentType: 'general', mode: 'auto', permission: 'read-only', approvalMode: 'manual', reasoningEffort: 'default' },
    onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
    onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(),
    sidebarOpen: true, onToggleSidebar: vi.fn(),
  }))
  expect(await view.findByText('All checks passed.')).toBeTruthy()
  expect(view.queryByText('Inspecting the project.')).toBeNull()
  const toggle = view.getByRole('button', { name: 'Completed process' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(view.getByText('Inspecting the project.')).toBeTruthy()
})
