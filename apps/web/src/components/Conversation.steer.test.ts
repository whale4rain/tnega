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
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each([true, false])('sends steering to the existing session while running remotely=%s', async remote => {
  const detail: SessionDetail = {
    summary: { id: 'session', title: 'Test session', workspace: '/work', createdAt: 1, updatedAt: 1, eventCount: 0 },
    events: [], surface: [], context: { tokens: 0, limit: 0, ratio: 0 },
    metrics: { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, running: remote,
  }
  vi.spyOn(api, 'session').mockResolvedValue(detail)
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const steer = vi.spyOn(api, 'steer').mockResolvedValue({ accepted: true })
  const stop = vi.spyOn(api, 'stop').mockResolvedValue({ stopped: true })
  const stream = vi.mocked(streamRun).mockImplementation(() => new Promise(() => {}))
  const view = render(createElement(Conversation, {
    workspace: '/work', sessionId: 'session', config: undefined,
    draftSettings: { agentType: 'general', mode: 'auto', permission: 'read-only', reasoningEffort: 'default' },
    onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
    onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(), onOpenFile: vi.fn(),
    sidebarOpen: true, onToggleSidebar: vi.fn(),
  }))
  await view.findByText('Test session')
  const input = view.getByRole('textbox')
  if (!remote) {
    fireEvent.change(input, { target: { value: 'first request' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
  }
  fireEvent.change(input, { target: { value: 'change direction' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(steer).toHaveBeenCalledWith('/work', 'session', 'change direction', []))
  expect(await view.findByText('Steering sent. The agent will read it at the next step.')).toBeTruthy()
  expect(stream).toHaveBeenCalledTimes(remote ? 0 : 1)
  expect(stop).not.toHaveBeenCalled()
  expect(view.getByRole('button', { name: 'Stop' })).toBeTruthy()
})
