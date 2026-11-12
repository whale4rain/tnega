// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { AccountContext } from '../lib/account'
import type { AuthSession, SessionSummary } from '../lib/types'
import { Conversation, recentForWelcome } from './Conversation'
import type { RunSettings } from './Composer'

const draft: RunSettings = { agentType: 'coding', mode: 'auto', permission: 'read-only', approvalMode: 'manual', reasoningEffort: 'default' }

vi.mock('./Composer', () => ({ Composer: () => null, SessionControls: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const summary = (id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, title: `Session ${id}`, workspace: '/work', createdAt: 1, updatedAt, eventCount: 4, ...extra })

const props = (extra: Record<string, unknown> = {}) => ({
  workspace: '/work', sessionId: undefined, config: undefined,
  draftSettings: draft,
  onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
  onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(), onOpenFile: vi.fn(),
  sidebarOpen: true, onToggleSidebar: vi.fn(),
  ...extra,
})

it('picks the latest few sessions of this workspace for the welcome, without forks or empty ones', () => {
  const sessions = [
    summary('old', 1), summary('new', 5), summary('fork', 9, { parentSessionId: 'new' }),
    summary('empty', 8, { eventCount: 0 }), summary('elsewhere', 7, { workspace: '/other' }), summary('mid', 3), summary('older', 2),
  ]
  expect(recentForWelcome(sessions, '/work').map(session => session.id)).toEqual(['new', 'mid', 'older'])
})

it('greets the signed-in person by name and reopens a recent session', () => {
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const onOpenSession = vi.fn()
  const session: AuthSession = { account: { id: 'a', login: 'ocean', name: 'Ocean Rain', role: 'owner', disabled: false, createdAt: '' } }
  const view = render(createElement(AccountContext.Provider, { value: session },
    createElement(Conversation, props({ recentSessions: [summary('s1', Date.now() - 7_200_000)], onOpenSession }))))
  expect(view.getByRole('heading', { level: 2 }).textContent).toMatch(/, Ocean\./u)
  fireEvent.click(view.getByRole('button', { name: 'Open Session s1' }))
  expect(onOpenSession).toHaveBeenCalledWith('s1')
  expect(view.getByText('Or start something new')).toBeTruthy()
})

it('shows only the starters when there is nothing to pick up, and no name on a local host', () => {
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const view = render(createElement(Conversation, props()))
  expect(view.getByRole('heading', { level: 2 }).textContent).not.toMatch(/,/u)
  expect(view.queryByLabelText('Pick up where you left off')).toBeNull()
  expect(view.getByRole('button', { name: /Map the codebase/u })).toBeTruthy()
})
