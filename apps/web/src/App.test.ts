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
          effective: { model: 'preview' },
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

it('ignores an old workspace operation that requests a refresh after selection changes', async () => {
  render(createElement(App))
  fireEvent.click(await screen.findByRole('button', { name: 'Alpha session' }))
  await screen.findByText('Content for /alpha')
  fireEvent.click(screen.getByRole('button', { name: 'Compact context' }))
  await waitFor(() => expect(releaseOperation).toBeTypeOf('function'))
  fireEvent.click(screen.getByRole('button', { name: 'Beta session' }))
  await screen.findByText('Content for /beta')
  await act(async () => {
    releaseOperation?.()
  })
  expect(screen.queryByText('Content for /alpha')).toBeNull()
  expect(screen.getByText('Content for /beta')).toBeTruthy()
})

it('preserves the new selection when a previous workspace removal finishes', async () => {
  render(createElement(App))
  fireEvent.click(await screen.findByRole('button', { name: 'Alpha session' }))
  await screen.findByText('Content for /alpha')
  fireEvent.keyDown(
    screen.getByRole('button', { name: 'Actions for workspace alpha' }),
    { key: 'Enter' },
  )
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Remove from list' }),
  )
  await waitFor(() => expect(releaseOperation).toBeTypeOf('function'))
  fireEvent.click(screen.getByRole('button', { name: 'Beta session' }))
  await screen.findByText('Content for /beta')
  await act(async () => {
    releaseOperation?.()
  })
  expect(screen.getByText('Content for /beta')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Alpha session' })).toBeNull()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('loads every workspace and scopes the selected highlight by workspace and session', async () => {
  render(createElement(App))
  const beta = await screen.findByRole('button', { name: 'Beta session' })
  const alpha = screen.getByRole('button', { name: 'Alpha session' })
  fireEvent.click(beta)
  await screen.findByText('Content for /beta')
  expect(beta.getAttribute('aria-current')).toBe('page')
  expect(alpha.getAttribute('aria-current')).toBeNull()
  fireEvent.click(alpha)
  await screen.findByText('Content for /alpha')
  expect(alpha.getAttribute('aria-current')).toBe('page')
  expect(beta.getAttribute('aria-current')).toBeNull()
})

it('does not let a slow previous workspace replace the active conversation', async () => {
  delayAlpha = true
  render(createElement(App))
  await screen.findByRole('button', { name: 'Beta session' })
  fireEvent.click(screen.getByRole('button', { name: 'Alpha session' }))
  await waitFor(() => expect(releaseAlpha).toBeTypeOf('function'))
  fireEvent.click(screen.getByRole('button', { name: 'Beta session' }))
  await screen.findByText('Content for /beta')
  await act(async () => {
    releaseAlpha?.()
  })
  expect(screen.queryByText('Content for /alpha')).toBeNull()
  expect(
    screen
      .getByRole('button', { name: 'Beta session' })
      .getAttribute('aria-current'),
  ).toBe('page')
})
