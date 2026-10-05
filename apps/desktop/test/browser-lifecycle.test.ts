import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'

const fixture = vi.hoisted(() => ({ nextId: 0, targets: new Set<string>(), urls: [] as string[], listeners: new Map<string, (event: unknown, value: unknown) => void>() }))

vi.mock('electron', () => ({
  app: {},
  ipcMain: {
    on: (name: string, listener: (event: unknown, value: unknown) => void) => fixture.listeners.set(name, listener),
    removeListener: (name: string) => fixture.listeners.delete(name),
  },
  BrowserWindow: class {
    webContents = { send: vi.fn() }
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    isDestroyed() { return false }
    isMinimized() { return false }
  },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      debugger: {
        isAttached: () => false,
        attach: () => {}, detach: () => {},
        sendCommand: async () => ({ targetInfo: { targetId: this.id } }),
      },
      loadURL: vi.fn(async (url: string) => { fixture.urls.push(url) }),
      setWindowOpenHandler: () => {},
      close: () => { fixture.targets.delete(this.id) },
      getURL: () => 'about:blank', getTitle: () => '', isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    })
    id = `target-${++fixture.nextId}`
    constructor() { fixture.targets.add(this.id) }
    setBorderRadius() {}
    setBounds() {}
  },
}))

vi.mock('@tnega/browser-playwright', () => ({
  cdpPageSource: (options: object) => options,
  PlaywrightBrowserHost: class {
    constructor(readonly source: { targetId(): Promise<string>, closeTarget(id: string): Promise<void> }) {}
    async close() {}
  },
}))

const { DesktopBrowser } = await import('../src/browser.js')

describe('desktop browser tab recovery', () => {
  it('acquires a new live target after the last tab closes', async () => {
    const browser = new DesktopBrowser(new BrowserWindow(), () => true)
    // The real CDP source asks the desktop host for the target to acquire.
    const source: unknown = Reflect.get(browser.host, 'source')
    if (!source || typeof source !== 'object') throw new Error('source unavailable')
    const targetId: unknown = Reflect.get(source, 'targetId')
    const closeTarget: unknown = Reflect.get(source, 'closeTarget')
    if (typeof targetId !== 'function' || typeof closeTarget !== 'function') throw new Error('target callbacks unavailable')
    const first: string = await targetId()
    await closeTarget(first)
    const replacement: string = await targetId()
    expect(replacement).not.toBe(first)
    expect(fixture.targets.has(replacement)).toBe(true)
    await closeTarget(replacement)
    fixture.listeners.get('tnega:browser-navigate')?.({}, 'https://example.com')
    await vi.waitFor(() => expect(fixture.urls).toContain('https://example.com'))
    await browser.dispose()
  })
})
