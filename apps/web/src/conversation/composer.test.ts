// @vitest-environment jsdom
import { createElement } from 'react'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Theme } from '@radix-ui/themes'
import { ChatView } from './ChatView'
import * as api from '../api'
import type { DisplayPlan } from '../planDisplay'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
function setup(apiKeySet = true, plan?: DisplayPlan) {
  const stream = vi.spyOn(api, 'streamRun').mockResolvedValue(undefined)
  render(
    createElement(
      Theme,
      {},
      createElement(ChatView, {
        workspace: '/project',
        sessionId: 'one',
        summary: {
          id: 'one',
          title: 'Test',
          workspace: '/project',
          createdAt: 0,
          updatedAt: 0,
          eventCount: 0,
        },
        context: null,
        sessionRunning: false,
        messages: [],
        apiKeySet,
        plan,
        onSettings: vi.fn(),
        onNewSession: vi.fn().mockResolvedValue(undefined),
        onRefresh: vi.fn().mockResolvedValue(undefined),
        onForkAt: vi.fn().mockResolvedValue(undefined),
        onMessagesChange: vi.fn(),
        onPlanChange: vi.fn(),
        onModeChange: vi.fn().mockResolvedValue(undefined),
      }),
    ),
  )
  return {
    stream,
    input: screen.getByRole('textbox', { name: 'Message Tnega' }),
  }
}
it('keeps IME confirmation and Shift+Enter local, submits Enter with permissions opt-in', async () => {
  const { stream, input } = setup()
  fireEvent.change(input, { target: { value: '解释这段代码' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(stream).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
  expect(stream.mock.calls[0]?.[2]).toEqual({
    prompt: '解释这段代码',
    allowNetwork: false,
    allowShell: false,
  })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy(),
  )
})
it('retains the draft when the model is not configured', () => {
  const { stream, input } = setup(false)
  fireEvent.change(input, { target: { value: 'Keep this draft' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(stream).not.toHaveBeenCalled()
  expect(screen.getByDisplayValue('Keep this draft')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy()
})

it('places the live plan above the input and lets it collapse without losing the draft', () => {
  const { input } = setup(true, {
    status: 'running',
    items: [
      { id: '1', title: 'Inspect parser', status: 'done' },
      { id: '2', title: 'Run tests', status: 'pending' },
    ],
  })
  fireEvent.change(input, { target: { value: 'Keep drafting' } })
  const plan = screen.getByRole('region', { name: 'Execution plan' })
  expect(plan.closest('[aria-label="Message composer"]')).toBeTruthy()
  expect(
    plan.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(plan.querySelector('details')?.open).toBe(true)
  fireEvent.click(screen.getByText('Plan'))
  expect(plan.querySelector('details')?.open).toBe(false)
  expect(screen.getByDisplayValue('Keep drafting')).toBeTruthy()
})
