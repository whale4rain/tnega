import { afterEach, describe, expect, it } from 'vitest'
import { desktopBrowser, displayUrl, viewportRect } from './desktop-browser'

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
})
