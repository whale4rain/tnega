// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, streamRun } from '../lib/api'
import type { SessionDetail, SessionRecovery } from '../lib/types'
import { Conversation } from './Conversation'

vi.mock('../lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  streamRun: vi.fn(),
}))
vi.mock('./Composer', () => ({ Composer: () => null, SessionControls: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mount(recovery: SessionRecovery) {
  const detail: SessionDetail = {
    summary: { id: 'session', title: 'Crashed session', workspace: '/work', createdAt: 1, updatedAt: 1, eventCount: 0 },
    events: [], surface: [], context: { tokens: 0, limit: 0, ratio: 0 },
    metrics: { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, running: false,
    recovery,
  }
  vi.spyOn(api, 'session').mockResolvedValue(detail)
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const recover = vi.spyOn(api, 'recover').mockResolvedValue({ resumeQueued: true })
  const stream = vi.mocked(streamRun).mockResolvedValue(undefined)
  const view = render(createElement(Conversation, {
    workspace: '/work', sessionId: 'session', config: undefined,
    draftSettings: { agentType: 'general', mode: 'auto', permission: 'read-only', reasoningEffort: 'default' },
    onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
    onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(), onOpenFile: vi.fn(),
    sidebarOpen: true, onToggleSidebar: vi.fn(),
  }))
  return { view, recover, stream }
}

it('continues a run the app stopped when no cut-off call may have taken effect', async () => {
  const { view, recover, stream } = mount({ safe: true, uncertainCalls: [] })
  await waitFor(() => expect(recover).toHaveBeenCalledWith('/work', 'session'))
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
  expect(vi.mocked(stream).mock.calls[0]?.[5]).toBe(true)
  expect(view.queryByRole('button', { name: 'Resume' })).toBeNull()
})

it('asks before continuing when a cut-off call may already have run', async () => {
  const { view, recover, stream } = mount({ safe: false, uncertainCalls: ['shell'] })
  const resume = await view.findByRole('button', { name: 'Resume' })
  expect(view.getByText(/shell may already have taken effect/)).toBeTruthy()
  expect(recover).not.toHaveBeenCalled()
  fireEvent.click(resume)
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
  expect(recover).toHaveBeenCalledTimes(1)
})
