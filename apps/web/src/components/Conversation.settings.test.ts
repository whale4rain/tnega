// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, streamRun } from '../lib/api'
import type { SessionDetail, SessionEvent } from '../lib/types'
import { Conversation } from './Conversation'

vi.mock('../lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  streamRun: vi.fn(),
}))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(streamRun).mockReset() })

const summary = { id: 'session', title: 'Test session', workspace: '/work', createdAt: 1, updatedAt: 1, eventCount: 3 }

/** A Session whose first turn is still running. */
function running(): SessionDetail {
  const events: SessionEvent[] = [
    { id: 'e1', seq: 1, ts: 1, type: 'turn/start', payload: { turn: 1 } },
    { id: 'e2', seq: 2, ts: 2, type: 'user/message', payload: { content: 'fix the build' } },
    { id: 'e3', seq: 3, ts: 3, type: 'assistant/message', payload: { content: 'Looking at the errors.' } },
  ]
  return {
    summary, events, context: { tokens: 0, limit: 0, ratio: 0 },
    metrics: { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, running: true,
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

it('changes permissions while a turn runs and says the change applies from the next step', async () => {
  vi.spyOn(api, 'session').mockResolvedValue(running())
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const patch = vi.spyOn(api, 'patchSession').mockResolvedValue({ summary: { ...summary, permission: 'workspace-write' } })
  const view = mount()
  await view.findByText('Looking at the errors.')

  // The agent and the mode shape the whole run; the rest applies per step.
  expect(view.getByRole('button', { name: /^Agent:/ })).toHaveProperty('disabled', true)
  expect(view.getByRole('button', { name: /^Mode:/ })).toHaveProperty('disabled', true)
  expect(view.getByRole('button', { name: /^Model:/ })).toHaveProperty('disabled', false)
  const access = view.getByRole('button', { name: /^Access:/ })
  expect(access).toHaveProperty('disabled', false)

  fireEvent.click(access)
  fireEvent.click(view.getByRole('option', { name: /Workspace write/ }))
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/work', 'session', { permission: 'workspace-write' }))
  const line = await view.findByRole('note')
  expect(line.textContent).toBe('Permissions set to workspace write · applies from the next step')
})
