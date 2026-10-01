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

export class DesktopBrowser {
  readonly view: WebContentsView
  readonly host: PlaywrightBrowserHost
  private _attached = false
  private _targetId: string | undefined
  private _waiters: Array<() => void> = []
  private readonly _disposers: Array<() => void> = []

  constructor(private readonly _window: BrowserWindow, private readonly _isTrusted: (event: IpcMainEvent) => boolean) {
    this.view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    const contents = this.view.webContents
    // Popups open in the same view so the agent never loses track of the page.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^(?:https?|file|data|about):/u.test(url)) void contents.loadURL(url)
      return { action: 'deny' }
    })
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      contents.on(event as 'did-navigate', () => this._publish())
    }
    void contents.loadURL('about:blank')

    this.host = new PlaywrightBrowserHost(cdpPageSource({
      endpoint: debuggingEndpoint,
      targetId: () => this._target(),
      prepare: () => this.reveal(),
    }))

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
      if (typeof value === 'string' && value.trim()) void contents.loadURL(normalizeBrowserUrl(value)).catch(() => {})
    })
    on('tnega:browser-command', (_event, value) => {
      if (value === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
      if (value === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
      if (value === 'reload') contents.reload()
      if (value === 'stop') contents.stop()
      if (value === 'state') this._publish()
    })
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
    if (!this._window.isDestroyed() && this._attached) this._window.contentView.removeChildView(this.view)
    this.view.webContents.close()
  }

  private _place(rect: BrowserRect | null): void {
    if (this._window.isDestroyed()) return
    if (!rect) {
      if (this._attached) this._window.contentView.removeChildView(this.view)
      this._attached = false
      return
    }
    if (!this._attached) {
      this._window.contentView.addChildView(this.view)
      this._attached = true
    }
    this.view.setBounds(rect)
    for (const resolve of this._waiters.splice(0)) resolve()
  }

  private async _target(): Promise<string> {
    if (this._targetId) return this._targetId
    const debug = this.view.webContents.debugger
    const attached = debug.isAttached()
    if (!attached) debug.attach('1.3')
    try {
      const { targetInfo } = await debug.sendCommand('Target.getTargetInfo') as { targetInfo: { targetId: string } }
      this._targetId = targetInfo.targetId
      return targetInfo.targetId
    } finally {
      if (!attached) debug.detach()
    }
  }

  private _publish(): void {
    if (this._window.isDestroyed()) return
    const contents = this.view.webContents
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

