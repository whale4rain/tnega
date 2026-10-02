import { app, ipcMain, WebContentsView, type BrowserWindow, type IpcMainEvent } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeBrowserUrl } from '@tnega/browser'
import { cdpPageSource, PlaywrightBrowserHost } from '@tnega/browser-playwright'

/**
 * The agent's in-app browser: a WebContentsView in its own session partition,
 * shown in the renderer's Browser panel and driven by Playwright over the
 * app's local remote-debugging endpoint.
 *
 * Only this view's CDP target is ever driven; the app UI is another target of
 * the same endpoint and is never touched. The endpoint listens on 127.0.0.1
 * only, and Chromium refuses DevTools WebSocket connections that carry a web
 * Origin unless --remote-allow-origins is set, so pages (including the ones the
 * agent browses) cannot reach it.
 */

const PARTITION = 'persist:tnega-browser'
const REVEAL_TIMEOUT_MS = 2_000

export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserViewState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** Must run before `app` is ready: Chromium reads the switch at startup. */
export function enableBrowserDebugging(): void {
  // A stale port file from the previous run would point at a dead port.
  rmSync(join(app.getPath('userData'), 'DevToolsActivePort'), { force: true })
  app.commandLine.appendSwitch('remote-debugging-port', '0')
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
}

async function debuggingEndpoint(): Promise<string> {
  const file = join(app.getPath('userData'), 'DevToolsActivePort')
  for (let attempt = 0; attempt < 50 && !existsSync(file); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const port = Number(readFileSync(file, 'utf8').split('\n')[0])
  if (!Number.isInteger(port) || port <= 0) throw new Error('remote debugging port is not available')
  return `http://127.0.0.1:${port}`
}

export function parseBrowserRect(value: unknown): BrowserRect | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const numbers = [record.x, record.y, record.width, record.height]
  if (!numbers.every(entry => typeof entry === 'number' && Number.isFinite(entry))) return undefined
  const [x, y, width, height] = numbers.map(entry => Math.round(entry as number)) as [number, number, number, number]
  if (width < 1 || height < 1) return null
  return { x, y, width, height }
}

/** Corner radius of the page card, matching the renderer's `.browser-viewport`. */
const VIEW_RADIUS = 10

interface TabView {
  view: WebContentsView
  targetId: string
}

export class DesktopBrowser {
  readonly host: PlaywrightBrowserHost
  private readonly _views = new Map<string, TabView>()
  private _active: TabView | undefined
  private _first: Promise<TabView>
  private _bounds: BrowserRect | null = null
  private _attached = false
  private _waiters: Array<() => void> = []
  private readonly _disposers: Array<() => void> = []

  constructor(private readonly _window: BrowserWindow, private readonly _isTrusted: (event: IpcMainEvent) => boolean) {
    this._first = this._create().then(tab => {
      this._active ??= tab
      return tab
    })

    this.host = new PlaywrightBrowserHost(cdpPageSource({
      endpoint: debuggingEndpoint,
      targetId: async () => (await this._first).targetId,
      openTarget: async () => (await this._create()).targetId,
      activateTarget: async id => this._activate(id),
      closeTarget: async id => this._close(id),
      prepare: () => this.reveal(),
    }), {
      // Unpackaged Electron prints these into every page; they are not the page's problems.
      ignoreConsole: text => text.includes('Electron Security Warning'),
    })

    const on = (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => {
      const guarded = (event: IpcMainEvent, ...args: unknown[]) => {
        if (this._isTrusted(event)) listener(event, ...args)
      }
      ipcMain.on(channel, guarded)
      this._disposers.push(() => ipcMain.removeListener(channel, guarded))
    }
    on('tnega:browser-bounds', (_event, value) => {
      const rect = parseBrowserRect(value)
      if (rect !== undefined) this._place(rect)
    })
    on('tnega:browser-navigate', (_event, value) => {
      const contents = this._active?.view.webContents
      if (contents && typeof value === 'string' && value.trim()) void contents.loadURL(normalizeBrowserUrl(value)).catch(() => {})
    })
    on('tnega:browser-command', (_event, value) => {
      const contents = this._active?.view.webContents
      if (!contents) return
      if (value === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
      if (value === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
      if (value === 'reload') contents.reload()
      if (value === 'stop') contents.stop()
      if (value === 'state') this._publish()
    })
  }

  /** The visible tab's view. */
  get view(): WebContentsView {
    const view = this._active?.view
    if (!view) throw new Error('the in-app browser has not started')
    return view
  }

  /** Ask the renderer to show the panel and wait until the view is on screen. */
  async reveal(): Promise<void> {
    if (this._window.isMinimized()) this._window.showInactive()
    if (this._attached) return
    const shown = new Promise<void>(resolve => this._waiters.push(resolve))
    this._window.webContents.send('tnega:browser-reveal')
    await Promise.race([shown, new Promise(resolve => setTimeout(resolve, REVEAL_TIMEOUT_MS))])
  }

  async dispose(): Promise<void> {
    for (const dispose of this._disposers.splice(0)) dispose()
    await this.host.close()
    for (const tab of this._views.values()) {
      if (!this._window.isDestroyed() && this._attached && tab === this._active) this._window.contentView.removeChildView(tab.view)
      tab.view.webContents.close()
    }
    this._views.clear()
  }

  private async _create(): Promise<TabView> {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    view.setBorderRadius(VIEW_RADIUS)
    const contents = view.webContents
    // Links that open a new window become new tabs the agent can see.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^(?:https?|file|data|about):/u.test(url)) void this.host.newTab(url).catch(() => {})
      return { action: 'deny' }
    })
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      contents.on(event as 'did-navigate', () => { if (this._active?.view === view) this._publish() })
    }
    await contents.loadURL('about:blank').catch(() => {})
    const tab = { view, targetId: await targetIdOf(view) }
    this._views.set(tab.targetId, tab)
    return tab
  }

  private _activate(id: string): void {
    const next = this._views.get(id)
    if (!next || next === this._active) return
    const previous = this._active
    this._active = next
    if (this._attached && !this._window.isDestroyed()) {
      if (previous) this._window.contentView.removeChildView(previous.view)
      this._window.contentView.addChildView(next.view)
      if (this._bounds) next.view.setBounds(this._bounds)
    }
    this._publish()
  }

  private _close(id: string): void {
    const tab = this._views.get(id)
    if (!tab) return
    this._views.delete(id)
    if (tab === this._active) {
      if (this._attached && !this._window.isDestroyed()) this._window.contentView.removeChildView(tab.view)
      this._active = undefined
    }
    tab.view.webContents.close()
  }

  private _place(rect: BrowserRect | null): void {
    if (this._window.isDestroyed()) return
    this._bounds = rect
    const view = this._active?.view
    if (!rect) {
      if (this._attached && view) this._window.contentView.removeChildView(view)
      this._attached = false
      return
    }
    if (!view) return
    if (!this._attached) {
      this._window.contentView.addChildView(view)
      this._attached = true
    }
    view.setBounds(rect)
    for (const resolve of this._waiters.splice(0)) resolve()
  }

  private _publish(): void {
    if (this._window.isDestroyed() || !this._active) return
    const contents = this._active.view.webContents
    const state: BrowserViewState = {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    }
    this._window.webContents.send('tnega:browser-state', state)
  }
}

async function targetIdOf(view: WebContentsView): Promise<string> {
  const debug = view.webContents.debugger
  const attached = debug.isAttached()
  if (!attached) debug.attach('1.3')
  try {
    const { targetInfo } = await debug.sendCommand('Target.getTargetInfo') as { targetInfo: { targetId: string } }
    return targetInfo.targetId
  } finally {
    if (!attached) debug.detach()
  }
}
