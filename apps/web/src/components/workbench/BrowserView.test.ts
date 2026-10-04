// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopBrowserState } from '../../lib/desktop-browser'
import { BrowserView } from './BrowserView'

let publish: ((state: DesktopBrowserState) => void) | undefined
const navigate = vi.fn()

beforeEach(() => {
  publish = undefined
  navigate.mockReset()
  // The live stream is not under test; keep it pending.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  vi.stubGlobal('tnegaDesktop', {
    browser: {
      setBounds: () => {},
      navigate,
      command: () => {},
      onState: (listener: (state: DesktopBrowserState) => void) => { publish = listener; return () => {} },
      onReveal: () => () => {},
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const page = (url: string, loading = false): DesktopBrowserState => ({ url, title: '', loading, canGoBack: false, canGoForward: false })

it('keeps the typed address and shows progress until the page gets there', () => {
  const view = render(createElement(BrowserView, {}))
  act(() => publish?.(page('https://example.com/')))
  const input = view.getByRole('textbox', { name: 'Address' }) as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: 'localhost:5173' } })
  fireEvent.submit(input.closest('form')!)
  fireEvent.blur(input)

  expect(navigate).toHaveBeenCalledWith('localhost:5173')
  expect(input.value).toBe('localhost:5173')
  expect(view.getByRole('progressbar', { name: 'Loading' })).toBeTruthy()

  // Still loading the old page: the typed address stays.
  act(() => publish?.(page('https://example.com/', true)))
  expect(input.value).toBe('localhost:5173')

  act(() => publish?.(page('http://localhost:5173/', true)))
  expect(input.value).toBe('http://localhost:5173/')
  expect(view.getByRole('progressbar', { name: 'Loading' })).toBeTruthy()

  act(() => publish?.(page('http://localhost:5173/', false)))
  expect(view.queryByRole('progressbar')).toBeNull()
})
