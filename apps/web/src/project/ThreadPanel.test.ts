// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ThreadPanel } from './ThreadPanel'

afterEach(cleanup)

it('sends a thread message without model or permission controls', async () => {
  const onSend = vi.fn().mockResolvedValue(undefined)
  render(createElement(ThreadPanel, {
    thread: { id: 'child', projectId: 'project', parentId: 'main', label: 'Research', goal: 'Review the sources', state: 'working', depth: 1, permission: 'read-only', createdAt: 0, updatedAt: 0 },
    events: [], loading: false, draft: 'Reviewing the material.', onClose: () => {}, onSend,
  }))
  expect(screen.getByText('Reviewing the material.')).toBeTruthy()
  const input = screen.getByRole('textbox', { name: 'Message thread' })
  fireEvent.change(input, { target: { value: 'Check the original source' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send to thread' }))
  await waitFor(() => expect(onSend).toHaveBeenCalledWith('Check the original source'))
  await waitFor(() => expect(input).toHaveProperty('value', ''))
  expect(screen.queryByRole('combobox')).toBeNull()
})

it('keeps the draft when sending to a thread fails', async () => {
  render(createElement(ThreadPanel, { events: [], loading: false, onClose: () => {}, onSend: async () => { throw new Error('Delivery failed') } }))
  const input = screen.getByRole('textbox', { name: 'Message thread' })
  fireEvent.change(input, { target: { value: 'Keep this draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send to thread' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Delivery failed')
  expect(input).toHaveProperty('value', 'Keep this draft')
})
