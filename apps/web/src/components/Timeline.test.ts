// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it } from 'vitest'
import type { Entry } from '../lib/timeline'
import { Timeline } from './Timeline'

afterEach(cleanup)

const completed: Entry = {
  kind: 'agent', id: 'agent-1', turn: 1, status: 'done',
  summary: { text: 'Finished the work.', sourceMessageId: 'answer' },
  blocks: [
    { kind: 'text', id: 'process', text: 'Investigating the problem.' },
    { kind: 'text', id: 'answer', text: 'Finished the work.' },
    { kind: 'notice', id: 'notice', tone: 'warn', text: 'A retry was required.' },
    { kind: 'files', id: 'files', files: [{ path: 'src/main.ts', additions: 2 }] },
  ],
}

it('shows final reply and files by default and reveals completed process on demand', () => {
  const view = render(createElement(Timeline, { entries: [completed], running: false, actions: {} }))
  expect(view.getByText('Finished the work.')).toBeTruthy()
  expect(view.getByText('src/main.ts')).toBeTruthy()
  expect(view.getByText('A retry was required.')).toBeTruthy()
  expect(view.queryByText('Investigating the problem.')).toBeNull()
  const toggle = view.getByRole('button', { name: 'Completed process' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(view.getByText('Investigating the problem.')).toBeTruthy()
})

it('keeps process fully visible while streaming', () => {
  const view = render(createElement(Timeline, { entries: [completed], running: true, actions: {} }))
  expect(view.getByText('Investigating the problem.')).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Completed process' })).toBeNull()
})
