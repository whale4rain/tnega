// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { SessionDetail, SessionEvent } from '../lib/types'
import { Conversation } from './Conversation'

vi.mock('./Composer', () => ({ Composer: () => null, SessionControls: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const turnEvents = (turn: number, base: number): SessionEvent[] => [
  { id: `start-${turn}`, seq: base, ts: base, type: 'turn/start', payload: { turn } },
  { id: `user-${turn}`, seq: base + 1, ts: base + 1, type: 'user/message', payload: { content: `question ${turn}` } },
  { id: `answer-${turn}`, seq: base + 2, ts: base + 2, type: 'assistant/message', payload: { content: `answer ${turn}` } },
  { id: `end-${turn}`, seq: base + 3, ts: base + 3, type: 'turn/end', payload: { turn, finishReason: 'stop' } },
]

function detail(events: SessionEvent[], page: SessionDetail['page']): SessionDetail {
  return {
    summary: { id: 'session', title: 'Long session', workspace: '/work', createdAt: 1, updatedAt: 9, eventCount: 12 },
    events,
    ...(page ? { page } : {}),
    context: { tokens: 0, limit: 0, ratio: 0 },
    metrics: { responses: 2, promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    running: false,
  }
}

function renderConversation() {
  return render(createElement(Conversation, {
    workspace: '/work', sessionId: 'session', config: undefined,
    draftSettings: { agentType: 'general', mode: 'auto', permission: 'read-only', reasoningEffort: 'default' },
    onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
    onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(), onOpenFile: vi.fn(),
    sidebarOpen: true, onToggleSidebar: vi.fn(),
  }))
}

it('opens the newest page and prepends older history when the reader scrolls to the top', async () => {
  const newest = detail(turnEvents(3, 9), { hasMore: true, beforeSeq: 9 })
  const older = detail(turnEvents(1, 1), { hasMore: false })
  const session = vi.spyOn(api, 'session').mockImplementation(async (_workspace, _id, page = {}) =>
    page.beforeSeq === 9 ? older : newest)
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const view = renderConversation()

  expect(await view.findByText('answer 3')).toBeTruthy()
  // The first read asks for a page, not for the whole log.
  expect(session).toHaveBeenCalledWith('/work', 'session', { maxMessages: 50 })
  expect(view.queryByText('answer 1')).toBeNull()
  // No pager button: reaching the top loads the older page.
  expect(view.queryByRole('button', { name: 'Load older messages' })).toBeNull()

  fireEvent.scroll(view.container.querySelector('.conv-scroll')!)
  expect(await view.findByText('answer 1')).toBeTruthy()
  // Older history goes above what was already read, in its original order.
  const order = [...view.container.querySelectorAll('.timeline .prose')].map(node => node.textContent)
  expect(order).toEqual(['question 1', 'answer 1', 'question 3', 'answer 3'])
  expect(session).toHaveBeenCalledWith('/work', 'session', { beforeSeq: 9, maxMessages: 50 })
})

it('does not fetch older history while the reader is away from the top', async () => {
  const newest = detail(turnEvents(3, 9), { hasMore: true, beforeSeq: 9 })
  const session = vi.spyOn(api, 'session').mockResolvedValue(newest)
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const view = renderConversation()

  expect(await view.findByText('answer 3')).toBeTruthy()
  const scroller = view.container.querySelector('.conv-scroll') as HTMLElement
  scroller.scrollTop = 400
  fireEvent.scroll(scroller)
  expect(session).toHaveBeenCalledTimes(1)
})

it('hides the pager when the whole history fits in one page', async () => {
  vi.spyOn(api, 'session').mockResolvedValue(detail(turnEvents(1, 1), { hasMore: false }))
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [] })
  const view = renderConversation()
  expect(await view.findByText('answer 1')).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Load older messages' })).toBeNull()
})
