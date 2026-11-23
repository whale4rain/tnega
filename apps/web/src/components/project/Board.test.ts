// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { fromSnapshot } from '../../lib/project-model'
import type { ProjectSnapshot, ThreadRecord } from '../../lib/project-types'
import { BoardPanel, boardGroups } from './Board'
import { ThreadCard } from './ThreadCard'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const COORD = 'coord'
const now = Date.now()

function thread(id: string, patch: Partial<ThreadRecord> = {}): ThreadRecord {
  return { id, projectId: 'p', parentId: COORD, label: `Thread ${id}`, goal: 'do it', state: 'idle', depth: 1, permission: 'workspace-write', createdAt: 1, updatedAt: now, ...patch }
}

function state(threads: ThreadRecord[]) {
  const snapshot: ProjectSnapshot = {
    project: { id: 'p', name: 'Launch', coordinatorId: COORD, createdAt: 1, updatedAt: 1 },
    coordinatorId: COORD,
    cursor: 0,
    threads: [thread(COORD, { parentId: undefined, depth: 0, label: 'Launch' }), ...threads],
    messages: [],
    inboxMessages: [],
    memory: [],
    library: { artifacts: [], resources: [] },
  }
  return fromSnapshot(snapshot)
}

const threads = [
  thread('ask', { state: 'waiting', detail: 'Which colour for the button?' }),
  thread('boom', { state: 'failed', detail: 'The build broke' }),
  thread('run', { state: 'working', checklist: [{ title: 'Write tests', status: 'active' }, { title: 'Ship', status: 'pending' }] }),
  thread('rest', { state: 'idle' }),
  thread('fin', { state: 'done' }),
  thread('old', { state: 'resolved', updatedAt: now - 3 * 86_400_000 }),
]
const seen = { rest: now, fin: now }

it('sorts threads into Your turn, On it, Waiting on others and done', () => {
  const groups = boardGroups(state(threads), seen)
  expect(groups.yours.map(item => item.id).sort()).toEqual(['ask', 'boom'])
  expect(groups.onIt.map(item => item.id)).toEqual(['run'])
  expect(groups.others.map(item => item.id)).toEqual(['rest'])
  expect(groups.done.map(item => item.id).sort()).toEqual(['fin', 'old'])
})

it('answers what needs you first, as work rows, and keeps the dashboard out', () => {
  const onOpenThread = vi.fn()
  const view = render(createElement(BoardPanel, { workspace: '/w', state: state(threads), seen, onOpenThread }))
  expect(view.getByRole('heading', { name: 'Launch' })).toBeTruthy()
  expect(view.getByText('4 going')).toBeTruthy()
  const regions = view.getAllByRole('region').map(region => region.getAttribute('aria-label'))
  expect(regions).toEqual(['Your turn', 'On it', 'Waiting on others', 'Done'])

  const yours = view.getByRole('region', { name: 'Your turn' })
  expect(yours.querySelectorAll('.work-row.tone-you')).toHaveLength(2)
  expect(within(yours).getByText('Which colour for the button?')).toBeTruthy()
  // A failure reason takes the danger tone; one mark per row.
  expect(within(yours).getByText('The build broke').className).toContain('failed')
  for (const row of view.container.querySelectorAll('.work-row')) expect(row.querySelectorAll('.pen-mark')).toHaveLength(1)
  // The step the thread is on, not a segment bar or token count.
  expect(within(view.getByRole('region', { name: 'On it' })).getByText('Write tests')).toBeTruthy()
  expect(view.container.querySelector('.board-steps, .board-progress, .board-chip')).toBeNull()
  expect(view.container.textContent).not.toMatch(/tokens|active/)

  fireEvent.click(view.getByRole('button', { name: 'Thread ask: Waiting on you' }))
  expect(onOpenThread).toHaveBeenCalledWith('ask')
})

it('folds finished work into one line that opens the history by day', () => {
  const view = render(createElement(BoardPanel, { workspace: '/w', state: state(threads), seen, onOpenThread: vi.fn() }))
  const line = view.getByRole('button', { name: /1 done today/ })
  expect(view.queryByText('Thread fin')).toBeNull()
  fireEvent.click(line)
  expect(line.getAttribute('aria-expanded')).toBe('true')
  expect(view.getByText('Today')).toBeTruthy()
  expect(view.getByText('Thread fin')).toBeTruthy()
  expect(view.getByText('Thread old')).toBeTruthy()
})

it('shows an empty Board as a drawn arrow and one sentence', () => {
  const view = render(createElement(BoardPanel, { workspace: '/w', state: state([]), seen: {}, onOpenThread: vi.fn() }))
  const empty = view.container.querySelector('.wb-empty')!
  expect(empty.querySelector('.pen-arrow')).toBeTruthy()
  expect(empty.querySelectorAll('p')).toHaveLength(1)
})

it('draws a thread card as one work row with a single mark, and tints the open one', () => {
  const onOpen = vi.fn()
  const onReply = vi.fn()
  const view = render(createElement(ThreadCard, { state: state(threads), threadId: 'ask', active: true, onOpen, onReply }))
  const card = view.container.querySelector('.thread-card')!
  expect(card.className).toContain('active')
  expect(card.querySelectorAll('.pen-mark')).toHaveLength(1)
  const open = view.getByRole('button', { name: 'Open thread Thread ask: Waiting on you' })
  expect(open.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(open)
  expect(onOpen).toHaveBeenCalledWith('ask')
  fireEvent.click(view.getByRole('button', { name: 'Reply to Thread ask' }))
  expect(onReply).toHaveBeenCalled()
})
