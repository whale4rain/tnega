// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionSummary } from '../lib/types'
import { WelcomeHero, WelcomeRecent, WelcomeStarters } from './Welcome'

afterEach(cleanup)

it('greets you by the time of day in one line', () => {
  const view = render(createElement(WelcomeHero, { agentType: 'general', now: new Date(2026, 10, 12, 9) }))
  expect(view.getByRole('heading').textContent).toBe('Good morning. What’s on your mind?')
  expect(view.container.querySelector('p')).toBeNull()
})

it('sends a starter as the first message, and not while sending is blocked', () => {
  const onPick = vi.fn()
  const view = render(createElement(WelcomeStarters, { agentType: 'coding', onPick, disabled: false }))
  fireEvent.click(view.getByRole('button', { name: 'Hunt a bug' }))
  expect(onPick).toHaveBeenCalledWith(expect.stringContaining('Look for likely bugs'))

  view.rerender(createElement(WelcomeStarters, { agentType: 'coding', onPick, disabled: true }))
  expect(view.getByRole('button', { name: 'Hunt a bug' }).hasAttribute('disabled')).toBe(true)
})

function session(id: string, title: string, updatedAt: number): SessionSummary {
  return { id, title, workspace: '/work', createdAt: updatedAt, updatedAt, eventCount: 4 }
}

it('offers the three latest sessions in this folder and opens the one you pick', () => {
  const now = Date.UTC(2026, 10, 12, 12)
  const hour = 3_600_000
  const onOpen = vi.fn()
  const view = render(createElement(WelcomeRecent, {
    sessions: [session('old', 'Old one', now - 90 * hour), session('a', 'Fix login', now - 2 * hour), session('b', '', now - 24 * hour), session('c', 'Slow build', now - 72 * hour)],
    onOpen,
    now,
  }))
  expect(view.getByRole('heading').textContent).toBe('Pick up where you left off')
  expect(view.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
    'Fix login, 2h ago',
    'Untitled session, 1d ago',
    'Slow build, 3d ago',
  ])
  fireEvent.click(view.getByRole('button', { name: 'Fix login, 2h ago' }))
  expect(onOpen).toHaveBeenCalledWith('a')
})

it('shows nothing to pick up in a folder without sessions', () => {
  const view = render(createElement(WelcomeRecent, { sessions: [], onOpen: vi.fn() }))
  expect(view.container.innerHTML).toBe('')
})
