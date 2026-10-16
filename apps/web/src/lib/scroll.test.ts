// @vitest-environment jsdom
import { expect, it } from 'vitest'
import {
  applyFade,
  canMoveViewport,
  distanceFromBottom,
  fadeEdges,
  followsEnd,
  metricsOf,
  PIN_TOLERANCE,
  scrollsViewport,
  takesKeys,
  USER_INPUT_COOLDOWN,
} from './scroll'

const content = { scrollHeight: 2000, clientHeight: 500 }

it('follows the end only within the tolerance', () => {
  expect(distanceFromBottom({ ...content, scrollTop: 1500 })).toBe(0)
  expect(distanceFromBottom({ ...content, scrollTop: 1480 })).toBe(20)
  expect(followsEnd({ ...content, scrollTop: 1500 - PIN_TOLERANCE + 1 })).toBe(true)
  expect(followsEnd({ ...content, scrollTop: 1500 - PIN_TOLERANCE - 1 })).toBe(false)
})

it('treats content shorter than the viewport as being at the end', () => {
  const short = { scrollTop: 0, scrollHeight: 120, clientHeight: 500 }
  expect(distanceFromBottom(short)).toBe(0)
  expect(followsEnd(short)).toBe(true)
})

it('keeps the viewport still while the user is scrolling it themselves', () => {
  expect(canMoveViewport(1000, 1000 - USER_INPUT_COOLDOWN)).toBe(false)
  expect(canMoveViewport(1000, 1000 - USER_INPUT_COOLDOWN - 1)).toBe(true)
  expect(canMoveViewport(1000, Number.NEGATIVE_INFINITY)).toBe(true)
})

it('counts only scrolling keys outside fields as the user scrolling', () => {
  for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']) expect(scrollsViewport(key)).toBe(true)
  for (const key of ['a', 'Enter', 'Escape', 'Tab']) expect(scrollsViewport(key)).toBe(false)

  const field = document.createElement('textarea')
  expect(takesKeys(field)).toBe(true)
  expect(takesKeys(document.createElement('div'))).toBe(false)
  const editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  document.body.append(editable)
  expect(takesKeys(editable)).toBe(true)
})

it('fades only the edges that are scrolled away from their end', () => {
  const middle = { ...content, scrollTop: 800 }
  expect(fadeEdges(middle)).toEqual({ top: true, bottom: true })
  expect(fadeEdges(middle, 'top')).toEqual({ top: true, bottom: false })
  expect(fadeEdges(middle, 'bottom')).toEqual({ top: false, bottom: true })
  // At an end there is nothing to hide, and a short list has no edges at all.
  expect(fadeEdges({ ...content, scrollTop: 0 })).toEqual({ top: false, bottom: true })
  expect(fadeEdges({ ...content, scrollTop: 1500 })).toEqual({ top: true, bottom: false })
  expect(fadeEdges({ scrollTop: 0, scrollHeight: 120, clientHeight: 500 })).toEqual({ top: false, bottom: false })
})

it('marks a container as fading without touching the ones that cannot fade', () => {
  const element = document.createElement('div')
  expect(applyFade(element, { ...content, scrollTop: 800 })).toEqual({ top: true, bottom: true })
  expect(element.className).toBe('is-fading-top is-fading-bottom is-fading')

  applyFade(element, { ...content, scrollTop: 0 })
  expect(element.className).toBe('is-fading-bottom is-fading')

  applyFade(element, { scrollTop: 0, scrollHeight: 120, clientHeight: 500 })
  expect(element.className).toBe('')
})

it('reads the metrics of a live container', () => {
  const element = document.createElement('div')
  expect(metricsOf(element)).toEqual({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })
})
