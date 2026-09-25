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
import { ChatView } from './ChatView'
import * as api from '../api'
import type { DisplayPlan } from '../planDisplay'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
function setup(apiKeySet = true, plan?: DisplayPlan, sessionRunning = false) {
  const summary = {
    id: 'one',
    title: 'Test',
    workspace: '/project',
    createdAt: 0,
    updatedAt: 0,
    eventCount: 0,
  }
  const stream = vi.spyOn(api, 'streamRun').mockResolvedValue(undefined)
  render(
    createElement(ChatView, {
      workspace: '/project',
      sessionId: 'one',
      summary,
      context: null,
      sessionRunning,
      messages: [],
      apiKeySet,
      models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', reasoningEfforts: [] }],
      reasoningEffort: 'default',
      onModelChange: vi.fn().mockResolvedValue(undefined),
      onReasoningEffortChange: vi.fn().mockResolvedValue(undefined),
      plan,
      onSettings: vi.fn(),
      onNewSession: vi.fn().mockResolvedValue(undefined),
      onRefresh: vi.fn().mockResolvedValue(
        sessionRunning
          ? {
            summary,
            events: [],
            surface: [],
            context: { tokens: 0, limit: 0, ratio: 0 },
            running: true,
          }
          : undefined,
      ),
      onForkAt: vi.fn().mockResolvedValue(undefined),
      onMessagesChange: vi.fn(),
      onPlanChange: vi.fn(),
      onModeChange: vi.fn().mockResolvedValue(undefined),
    }),
  )
  return {
    stream,
    input: screen.getByLabelText('Message Tnega'),
  }
}

/**
 * The composer's input is the Astryx contentEditable, so a draft is typed by
 * writing the text node and letting its `input` handler serialize it —
 * `fireEvent.change` targets value-carrying controls and does nothing here.
 */
function type(input: HTMLElement, value: string) {
  input.textContent = value
  fireEvent.input(input)
}

it('keeps IME confirmation and Shift+Enter local, submits Enter with permissions opt-in', async () => {
  const { stream, input } = setup()
  type(input, '解释这段代码')
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(stream).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
  expect(stream.mock.calls[0]?.[2]).toEqual({
    prompt: '解释这段代码',
    permission: 'read-only',
  })
})

it('retains the draft when the model is not configured', async () => {
  const { stream, input } = setup(false)
  type(input, 'Keep this draft')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(stream).not.toHaveBeenCalled()
  await waitFor(() => expect(input.textContent).toBe('Keep this draft'))
  expect(screen.getByText('Connect a model to start a conversation.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy()
})

it('places the live plan above the input', () => {
  const { input } = setup(true, {
    status: 'running',
    items: [
      { id: '1', title: 'Inspect parser', status: 'done' },
      { id: '2', title: 'Run tests', status: 'pending' },
    ],
  })
  const plan = screen.getByRole('region', { name: 'Execution plan' })
  expect(plan.closest('[aria-label="Message composer"]')).toBeTruthy()
  expect(
    plan.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
})

it('keeps the composer typable during a run and only blocks sending', async () => {
  const { stream, input } = setup(true, undefined, true)

  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy(),
  )
  expect(input.getAttribute('contenteditable')).toBe('true')

  type(input, 'a follow-up thought')
  await waitFor(() => expect(input.textContent).toBe('a follow-up thought'))

  fireEvent.keyDown(input, { key: 'Enter' })
  expect(stream).not.toHaveBeenCalled()
})
