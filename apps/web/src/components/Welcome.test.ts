// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { WelcomeHero, WelcomeStarters } from './Welcome'

afterEach(cleanup)

it('greets you by the time of day and says where the agent will work', () => {
  const view = render(createElement(WelcomeHero, { workspace: '/home/me/notes', agentType: 'general', now: new Date(2026, 10, 12, 9) }))
  expect(view.getByRole('heading').textContent).toBe('Good morning. What’s on your mind?')
  expect(view.container.textContent).toContain('Working in notes as a general assistant.')
})

it('sends a starter as the first message, and not while sending is blocked', () => {
  const onPick = vi.fn()
  const view = render(createElement(WelcomeStarters, { agentType: 'coding', onPick, disabled: false }))
  fireEvent.click(view.getByRole('button', { name: 'Hunt a bug' }))
  expect(onPick).toHaveBeenCalledWith(expect.stringContaining('Look for likely bugs'))

  view.rerender(createElement(WelcomeStarters, { agentType: 'coding', onPick, disabled: true }))
  expect(view.getByRole('button', { name: 'Hunt a bug' }).hasAttribute('disabled')).toBe(true)
})
