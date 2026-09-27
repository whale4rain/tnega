// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ThreadPanel } from './ThreadPanel'

afterEach(cleanup)

it('shows delegated work without a user message input', () => {
  render(createElement(ThreadPanel, {
    thread: { id: 'child', projectId: 'project', parentId: 'main', label: 'Research', goal: 'Review the sources', state: 'working', depth: 1, permission: 'read-only', createdAt: 0, updatedAt: 0 },
    events: [], loading: false, draft: 'Reviewing the material.', onClose: () => {},
  }))
  expect(screen.getByText('Reviewing the material.')).toBeTruthy()
  expect(screen.getByText('Managed by the main agent')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
})
