// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationNav } from './ConversationNav'

// jsdom has no layout observer; Radix measures tooltip anchors with this API.
beforeEach(() => vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
}))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const turns = [
  { id: 'one', content: 'Fix the parser' },
  { id: 'two', content: 'Add recovery tests' },
  { id: 'three', content: '' },
]
it('selects any turn directly and identifies the current turn', () => {
  const onSelect = vi.fn()
  render(createElement(ConversationNav, { turns, index: 0, onSelect }))
  expect(screen.getByRole('button', { name: 'Turn 1: Fix the parser' }).getAttribute('aria-current')).toBe('step')
  fireEvent.click(screen.getByRole('button', { name: 'Turn 2: Add recovery tests' }))
  expect(onSelect).toHaveBeenCalledWith(1)
  expect(screen.getByRole('button', { name: 'Turn 3: Empty message' })).toBeTruthy()
})
it('supports keyboard navigation and clamps at the boundaries', () => {
  const onSelect = vi.fn()
  render(createElement(ConversationNav, { turns, index: 1, onSelect }))
  const marker = screen.getByRole('button', { name: 'Turn 2: Add recovery tests' })
  fireEvent.keyDown(marker, { key: 'ArrowUp' })
  expect(onSelect).toHaveBeenLastCalledWith(0)
  fireEvent.keyDown(marker, { key: 'End' })
  expect(onSelect).toHaveBeenLastCalledWith(2)
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Turn 3: Empty message')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(onSelect).toHaveBeenLastCalledWith(2)
})
it('does not show a ruler for fewer than two turns', () => {
  const view = render(createElement(ConversationNav, { turns: [], index: 0, onSelect: vi.fn() }))
  expect(screen.queryByRole('navigation')).toBeNull()
  view.rerender(createElement(ConversationNav, { turns: turns.slice(0, 1), index: 0, onSelect: vi.fn() }))
  expect(screen.queryByRole('navigation')).toBeNull()
})
