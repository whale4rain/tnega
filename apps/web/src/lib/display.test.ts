// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { applyDisplay, DISPLAY_DEFAULTS, useDisplay, type DisplayChange } from './display'

afterEach(() => { cleanup(); localStorage.clear() })

it('writes each preference as a root attribute that tokens.css reads', () => {
  const root = document.createElement('html')
  applyDisplay(root, { palette: 'forest', density: 'comfortable', textSize: 'large', readingWidth: 'full' })
  expect(root.dataset).toMatchObject({ palette: 'forest', density: 'comfortable', textSize: 'large', reading: 'full' })
  expect(root.getAttribute('data-text-size')).toBe('large')
})

it('restores stored choices, ignores unknown ones and persists changes', () => {
  localStorage.setItem('tnega.palette', 'sand')
  localStorage.setItem('tnega.density', 'roomy')
  let change: DisplayChange | undefined
  function Probe() {
    const [, set] = useDisplay()
    change = set
    return null
  }
  render(createElement(Probe))
  const root = document.documentElement
  expect(root.dataset.palette).toBe('sand')
  expect(root.dataset.density).toBe(DISPLAY_DEFAULTS.density)
  act(() => change?.('readingWidth', 'wide'))
  expect(root.dataset.reading).toBe('wide')
  expect(localStorage.getItem('tnega.readingWidth')).toBe('wide')
})
