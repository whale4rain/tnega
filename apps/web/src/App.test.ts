// @vitest-environment jsdom
import { createElement } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'

const workspaces = ['/alpha', '/beta']
const summaries = workspaces.map((workspace, index) => ({
  workspace,
  id: 'shared-id',
  title: index ? 'Beta session' : 'Alpha session',
  createdAt: 1,
  updatedAt: 1,
  eventCount: 1,
}))
let releaseAlpha: (() => void) | undefined
let delayAlpha = false
let releaseOperation: (() => void) | undefined
beforeEach(() => {
  localStorage.clear()
  delayAlpha = false
  releaseAlpha = undefined
  releaseOperation = undefined
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const workspace = url.searchParams.get('workspace')
      const summary = summaries.find((item) => item.workspace === workspace)!
      let body: unknown
      if (url.pathname === '/api/config')
        body = {
          apiKeySet: false,
          effective: { modelId: 'preview' },
          models: [],
          config: {},
          env: {},
        }
      else if (url.pathname === '/api/workspaces') {
        if (init?.method === 'DELETE') {
          await new Promise<void>((resolve) => {
            releaseOperation = resolve
          })
          body = { workspaces: ['/beta'] }
        } else body = { workspaces }
      } else if (url.pathname.endsWith('/compact')) {
        await new Promise<void>((resolve) => {
          releaseOperation = resolve
        })
        body = {}
      } else if (url.pathname === '/api/sessions')
        body = { workspace, sessions: [summary] }
      else if (url.pathname === '/api/sessions/shared-id') {
        if (workspace === '/alpha' && delayAlpha)
          await new Promise<void>((resolve) => {
            releaseAlpha = resolve
          })
        body = {
          summary,
          context: null,
          running: false,
          events: [
            {
              id: 'message',
              seq: 1,
              ts: 1,
              type: 'assistant/message',
              payload: { content: `Content for ${workspace}` },
            },
          ],
        }
      } else throw new Error(`Unexpected request: ${url.pathname}`)
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * Session rows are TreeList items now: the row activates through the button it
 * renders, while the selected state moved from `aria-current` on that button to
 * `aria-selected` on the surrounding `treeitem` row.
 */
function sessionRow(name: 'Alpha session' | 'Beta session') {
  return screen.getByRole('button', { name })
}
function findSessionRow(name: 'Alpha session' | 'Beta session') {
  // The first render in this file also pays the Astryx/StyleX style resolution
  // for the whole tree, which overruns the default one-second query timeout.
  return screen.findByRole('button', { name }, { timeout: 10_000 })
}
function isSelected(row: HTMLElement) {
  return row.closest('[role="treeitem"]')?.getAttribute('aria-selected')
}

it('ignores an old workspace operation that requests a refresh after selection changes', async () => {
  render(createElement(App))
  fireEvent.click(await findSessionRow('Alpha session'))
  await screen.findByText('Content for /alpha')
  fireEvent.click(screen.getByRole('button', { name: 'Compact context' }))
  await waitFor(() => expect(releaseOperation).toBeTypeOf('function'))
  fireEvent.click(sessionRow('Beta session'))
  await screen.findByText('Content for /beta')
  await act(async () => {
    releaseOperation?.()
  })
  expect(screen.queryByText('Content for /alpha')).toBeNull()
  expect(screen.getByText('Content for /beta')).toBeTruthy()
})

it('preserves the new selection when a previous workspace removal finishes', async () => {
  render(createElement(App))
  fireEvent.click(await findSessionRow('Alpha session'))
  await screen.findByText('Content for /alpha')
  fireEvent.keyDown(
    screen.getByRole('button', { name: 'Actions for workspace alpha' }),
    { key: 'Enter' },
  )
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Remove from list' }),
  )
  await waitFor(() => expect(releaseOperation).toBeTypeOf('function'))
  fireEvent.click(sessionRow('Beta session'))
  await screen.findByText('Content for /beta')
  await act(async () => {
    releaseOperation?.()
  })
  expect(screen.getByText('Content for /beta')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Alpha session' })).toBeNull()
})

it('loads every workspace and scopes the selected highlight by workspace and session', async () => {
  render(createElement(App))
  const beta = await findSessionRow('Beta session')
  const alpha = sessionRow('Alpha session')
  fireEvent.click(beta)
  await screen.findByText('Content for /beta')
  expect(isSelected(beta)).toBe('true')
  expect(isSelected(alpha)).toBeNull()
  fireEvent.click(alpha)
  await screen.findByText('Content for /alpha')
  expect(isSelected(alpha)).toBe('true')
  expect(isSelected(beta)).toBeNull()
})

it('does not let a slow previous workspace replace the active conversation', async () => {
  delayAlpha = true
  render(createElement(App))
  await findSessionRow('Beta session')
  fireEvent.click(sessionRow('Alpha session'))
  await waitFor(() => expect(releaseAlpha).toBeTypeOf('function'))
  fireEvent.click(sessionRow('Beta session'))
  await screen.findByText('Content for /beta')
  await act(async () => {
    releaseAlpha?.()
  })
  expect(screen.queryByText('Content for /alpha')).toBeNull()
  expect(isSelected(sessionRow('Beta session'))).toBe('true')
})
