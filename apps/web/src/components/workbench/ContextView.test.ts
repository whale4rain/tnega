// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import type { SessionContextReport } from '../../lib/types'
import { ContextView } from './ContextView'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const estimate = { system: 100, tools: 300, user: 20, injected: 0, assistant: 80, results: 500 }
const report: SessionContextReport = {
  title: 'Fix the parser', model: 'deepseek-chat', window: 128_000, compactAt: 0.75,
  current: { estimate, tokens: 1000, source: 'provider' },
  stats: { turns: 2, steps: 3, userInputs: 2, toolCalls: 4, toolErrors: 1, compactions: 1, promptTokens: 2400, completionTokens: 120, cachedTokens: 1200, reasoningTokens: 30, cacheHitRate: 0.5, cost: [{ amount: 0.0021, currency: 'CNY' }], pricedSteps: 3 },
  billed: { composition: { system: 240, tools: 720, user: 48, injected: 0, assistant: 192, results: 1200 }, output: 120 },
  timing: { activeMs: 20_000, waitingMs: 3000, thinkingMs: 4000, respondingMs: 5000, toolMs: 6000, otherMs: 2000, modelCalls: 3, toolRuns: 4 },
  steps: [1, 2, 3].map(index => ({
    turn: index < 3 ? 1 : 2, step: index < 3 ? index : 1, ts: 1_000 * index, modelId: 'flash', estimate, promptTokens: 400 * index, completionTokens: 40, cachedTokens: 200 * index, toolCalls: 1,
    timing: { waitingMs: 1000, thinkingMs: 0, respondingMs: 1000, toolMs: 2000, toolRuns: 1 },
    ...(index === 3 ? { compacted: true } : {}),
  })),
  turns: [],
  tools: [
    { name: 'computer_screenshot', calls: 3, failed: 0, durationMs: 300, images: 3, imageBytes: 300 * 1024, promptTokens: 1500, cachedTokens: 600, completionTokens: 30, cost: [{ amount: 0.0012, currency: 'CNY' }] },
    { name: 'read_file', calls: 1, failed: 1, durationMs: 20, images: 0, imageBytes: 0, promptTokens: 400, cachedTokens: 200, completionTokens: 40 },
  ],
  updatedAt: 3000,
}

it('asks for a session before showing anything', () => {
  const load = vi.spyOn(api, 'context')
  const view = render(createElement(ContextView, { workspace: '/work', sessionId: undefined, visible: true }))
  expect(view.getByText(/Open a session to see what its context is made of/)).toBeTruthy()
  expect(load).not.toHaveBeenCalled()
})

it('shows the session’s stats, window and trend, and follows the picked bar', async () => {
  const load = vi.spyOn(api, 'context').mockResolvedValue(report)
  const view = render(createElement(ContextView, { workspace: '/work', sessionId: 's1', visible: true }))
  expect(await view.findByText('Fix the parser')).toBeTruthy()
  expect(load).toHaveBeenCalledWith('/work', 's1', expect.anything())
  expect(view.getByRole('region', { name: 'Context stats' }).textContent).toContain('1 failed')
  expect(view.getByText('¥0.0021')).toBeTruthy()
  const tools = view.getByRole('region', { name: 'By tool' })
  expect(tools.querySelectorAll('tbody tr')).toHaveLength(2)
  expect(tools.textContent).toContain('3 · 300.0 KB')
  expect(tools.textContent).toContain('1 failed')
  expect(tools.textContent).toContain('¥0.0012')
  expect(view.getByRole('img', { name: '1,000 of 128,000 tokens used' })).toBeTruthy()
  // The latest request is described until another bar is picked.
  expect(view.getByText('Turn 2 · step 1')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: /^Turn 1 · step 2: 800 tokens sent$/ }))
  expect(view.getByText('Turn 1 · step 2')).toBeTruthy()
  fireEvent.click(view.getByRole('radio', { name: 'Turn' }))
  expect(view.getAllByRole('button', { name: /^Turn \d: / })).toHaveLength(2)
  expect(view.getByRole('button', { name: /^Turn 2: .*after a compaction/ })).toBeTruthy()
})

it('does not poll while hidden', async () => {
  const load = vi.spyOn(api, 'context').mockResolvedValue(report)
  const view = render(createElement(ContextView, { workspace: '/work', sessionId: 's1', visible: false }))
  await waitFor(() => expect(view.getByRole('button', { name: 'Refresh context' })).toBeTruthy())
  expect(load).not.toHaveBeenCalled()
})
