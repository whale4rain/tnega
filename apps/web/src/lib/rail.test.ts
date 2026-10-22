// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { revealInRail } from './rail'

afterEach(() => { vi.restoreAllMocks() })

function box(element: Element, left: number, width: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: left, y: 0, width, height: 30 }))
}

function setup(tabLeft: number, tabWidth = 80) {
  const rail = document.createElement('div')
  const tab = document.createElement('button')
  rail.append(tab)
  rail.scrollLeft = 0
  box(rail, 1000, 300)
  box(tab, tabLeft, tabWidth)
  const scrollIntoView = vi.fn()
  Object.assign(tab, { scrollIntoView })
  return { rail, tab, scrollIntoView }
}

it('scrolls only the rail to show a tab past its right end', () => {
  const { rail, tab, scrollIntoView } = setup(1260)
  revealInRail(rail, tab)
  // jsdom keeps scrollLeft as set; the tab ended 40px past the rail.
  expect(rail.scrollLeft).toBe(40)
  expect(scrollIntoView).not.toHaveBeenCalled()
})

it('scrolls back for a tab before its start and leaves a visible tab alone', () => {
  const before = setup(950)
  before.rail.scrollLeft = 120
  revealInRail(before.rail, before.tab)
  expect(before.rail.scrollLeft).toBe(70)

  const inside = setup(1100)
  revealInRail(inside.rail, inside.tab)
  expect(inside.rail.scrollLeft).toBe(0)
})
