import { afterEach, describe, expect, it } from 'vitest'
import { boundsFollower, desktopBrowser, displayUrl, viewportRect } from './desktop-browser'

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'tnegaDesktop')
})

describe('desktop browser bridge', () => {
  it('is only available when the desktop app exposes it', () => {
    expect(desktopBrowser()).toBeUndefined()
    Reflect.set(globalThis, 'tnegaDesktop', { pickFolder: () => undefined })
    expect(desktopBrowser()).toBeUndefined()
    const browser = { setBounds() {}, navigate() {}, command() {}, onState: () => () => {}, onReveal: () => () => {} }
    Reflect.set(globalThis, 'tnegaDesktop', { browser })
    expect(desktopBrowser()).toBe(browser)
  })

  it('hides the view when covered or collapsed and shows blank pages as empty', () => {
    const element = { getBoundingClientRect: () => ({ left: 700, top: 58, width: 580, height: 742 }) } as unknown as Element
    expect(viewportRect(element, false)).toEqual({ x: 700, y: 58, width: 580, height: 742 })
    expect(viewportRect(element, true)).toBeNull()
    expect(viewportRect({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) } as unknown as Element, false)).toBeNull()
    expect(displayUrl('about:blank')).toBe('')
    expect(displayUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
  })

  it('follows the card while the panel slides in, then stops once it holds still', () => {
    const queue: Array<() => void> = []
    const tick = () => queue.splice(0).forEach(callback => callback())
    let x = 1290
    const sent: Array<number | null> = []
    const follower = boundsFollower({
      measure: () => ({ x, y: 138, width: 486, height: 666 }),
      send: rect => sent.push(rect?.x ?? null),
      frame: callback => queue.push(callback),
      cancel: () => { queue.length = 0 },
    })
    follower.follow()
    // The panel moves without changing size: every frame lands at its new place.
    for (const next of [1134, 1001, 900, 820, 778]) {
      tick()
      x = next
    }
    for (let frame = 0; frame < 10; frame += 1) tick()
    expect(sent).toEqual([1290, 1134, 1001, 900, 820, 778])
    expect(queue).toHaveLength(0)
    follower.follow()
    tick()
    expect(sent).toHaveLength(6)
    follower.stop()
    expect(queue).toHaveLength(0)
  })
})
