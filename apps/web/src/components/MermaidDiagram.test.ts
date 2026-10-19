// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LinkContext } from '../lib/links'
import { Markdown } from './Markdown'

const pele = vi.hoisted(() => ({
  mountAsync: vi.fn(),
  update: vi.fn(),
  destroy: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('pele/lazy', () => ({ mountAsync: pele.mountAsync }))

const mounted = {
  get result() { return undefined },
  source: '',
  get error() { return undefined },
  get zoom() { return undefined },
  update: pele.update,
  destroy: pele.destroy,
  refresh: pele.refresh,
}

function canvas(view: ReturnType<typeof render>): HTMLElement | null {
  return view.container.querySelector('.mermaid-canvas')
}

function sourceOf(view: ReturnType<typeof render>): string | null | undefined {
  return view.container.querySelector('pre code')?.textContent
}

beforeEach(() => {
  pele.mountAsync.mockReset().mockImplementation(async (element: HTMLElement) => {
    element.innerHTML = '<svg data-testid="diagram" class="pele"><a href="http://localhost:5173/">server</a></svg>'
    return mounted
  })
  pele.update.mockReset()
  pele.destroy.mockReset()
  pele.refresh.mockReset()
})

afterEach(cleanup)

it('draws a mermaid fence as a diagram instead of a code block', async () => {
  const view = render(createElement(Markdown, { text: '```mermaid\nflowchart LR\n  A --> B\n```' }))
  await waitFor(() => expect(view.queryByTestId('diagram')).not.toBeNull())
  expect(pele.mountAsync).toHaveBeenCalledTimes(1)
  expect(pele.mountAsync.mock.calls[0]?.[1]).toBe('flowchart LR\n  A --> B')
  expect(view.container.querySelector('.code-block-lang')?.textContent).toBe('mermaid')
  expect(sourceOf(view)).toBeUndefined()
})

it('keeps the source one toggle away', async () => {
  const view = render(createElement(Markdown, { text: '```mermaid\nflowchart LR\n  A --> B\n```' }))
  await waitFor(() => expect(view.queryByTestId('diagram')).not.toBeNull())
  fireEvent.click(view.getByText('Source'))
  expect(sourceOf(view)).toBe('flowchart LR\n  A --> B')
  expect(canvas(view)?.hidden).toBe(true)
  fireEvent.click(view.getByText('Diagram'))
  expect(canvas(view)?.hidden).toBe(false)
})

it('falls back to the code block a fence rendered as before when the diagram cannot be drawn', async () => {
  pele.mountAsync.mockRejectedValueOnce(new Error('Parse error on line 2\nflowchart LR\n  A -->'))
  const view = render(createElement(Markdown, { text: '```mermaid\nflowchart LR\n  A -->\n```' }))
  await waitFor(() => expect(view.container.querySelector('.mermaid-canvas')).toBeNull())
  expect(sourceOf(view)).toBe('flowchart LR\n  A -->')
  expect(view.container.querySelector('.code-block-lang')?.textContent).toBe('mermaid')
  expect(view.getByLabelText('Copy code')).toBeTruthy()
  expect(view.queryByText('Source')).toBeNull()
})

it('takes the same route when pele cannot even be loaded', async () => {
  pele.mountAsync.mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
  const view = render(createElement(Markdown, { text: '```mermaid\nflowchart LR\n  A --> B\n```' }))
  await waitFor(() => expect(view.container.querySelector('.mermaid-canvas')).toBeNull())
  expect(sourceOf(view)).toBe('flowchart LR\n  A --> B')
})

it('opens diagram links in the Workbench instead of navigating the app away', async () => {
  const openLocalUrl = vi.fn()
  const view = render(createElement(LinkContext.Provider, {
    value: { openLocalUrl },
  }, createElement(Markdown, { text: '```mermaid\nflowchart LR\n  A --> B\n```' })))
  await waitFor(() => expect(view.queryByTestId('diagram')).not.toBeNull())
  fireEvent.click(view.getByText('server'))
  expect(openLocalUrl).toHaveBeenCalledWith('http://localhost:5173/')
})

it('stops observing pele when the message unmounts', async () => {
  const view = render(createElement(Markdown, { text: '```mermaid\nflowchart LR\n  A --> B\n```' }))
  await waitFor(() => expect(view.queryByTestId('diagram')).not.toBeNull())
  view.unmount()
  expect(pele.destroy).toHaveBeenCalled()
})
