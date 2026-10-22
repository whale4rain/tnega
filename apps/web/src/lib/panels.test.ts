// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PANEL_MS, useHeldWhileClosing, usePanelMotion } from './panels'

afterEach(() => {
  vi.useRealTimers()
})

it('holds a closing panel’s content until the fold has finished, and shows an opening one at once', () => {
  vi.useFakeTimers()
  const { result, rerender } = renderHook(({ open }) => useHeldWhileClosing(open), { initialProps: { open: true } })
  expect(result.current).toBe(true)
  rerender({ open: false })
  expect(result.current).toBe(true)
  act(() => { vi.advanceTimersByTime(PANEL_MS + 60) })
  expect(result.current).toBe(false)
  rerender({ open: true })
  expect(result.current).toBe(true)
})

it('animates the frame only for a fold', () => {
  vi.useFakeTimers()
  const { result, rerender } = renderHook(({ key }) => usePanelMotion(key), { initialProps: { key: 'true/false' } })
  expect(result.current).toBe(false)
  rerender({ key: 'true/true' })
  expect(result.current).toBe(true)
  act(() => { vi.advanceTimersByTime(PANEL_MS + 60) })
  expect(result.current).toBe(false)
})
