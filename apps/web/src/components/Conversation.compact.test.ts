// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { SessionDetail } from '../lib/types'
import { Conversation } from './Conversation'

vi.mock('./Composer', () => ({ Composer: () => null, SessionControls: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('shows compaction progress without hiding the conversation being summarized', async () => {
  const summary = { id: 'session', title: 'Test session', workspace: '/work', createdAt: 1, updatedAt: 2, eventCount: 2 }
  const detail: SessionDetail = { summary,
    events: [
      { id: 'user', seq: 1, ts: 1, type: 'user/message', payload: { content: 'Keep this request visible' } },
      { id: 'answer', seq: 2, ts: 2, type: 'assistant/message', payload: { content: 'Keep this answer visible' } },
    ], surface: [], running: false,
    context: { tokens: 200, limit: 1000, ratio: 0.2 }, metrics: { responses: 1, promptTokens: 200, completionTokens: 20, cachedTokens: 0 },
  }
  vi.spyOn(api, 'session').mockResolvedValue(detail)
  vi.spyOn(api, 'jobs').mockResolvedValue({ jobs: [] })
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  let finish: () => void = () => {}
  vi.spyOn(api, 'compact').mockImplementation(() => new Promise(resolve => { finish = () => resolve({ summary }) }))
  const view = render(createElement(Conversation, {
    workspace: '/work', sessionId: 'session', config: undefined,
    draftSettings: { agentType: 'general', mode: 'auto', permission: 'read-only', reasoningEffort: 'default' },
    onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
    onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(), onOpenFile: vi.fn(),
    sidebarOpen: true, onToggleSidebar: vi.fn(),
  }))
  await view.findByText('Keep this answer visible')
  fireEvent.click(view.getByRole('button', { name: 'Session actions' }))
  fireEvent.click(view.getByRole('menuitem', { name: 'Compact context' }))
  expect(await view.findByRole('status')).toHaveProperty('textContent', 'Compacting context…')
  expect(view.getByText('Keep this request visible')).toBeTruthy()
  expect(view.getByText('Keep this answer visible')).toBeTruthy()
  finish()
  await waitFor(() => expect(view.queryByRole('status')).toBeNull())
})
