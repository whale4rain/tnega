import type { CDPSession, Page } from 'playwright-core'

/**
 * A live view of the agent's page for a UI that is not the browser itself
 * (the web app): Chromium's CDP screencast pushes a JPEG whenever the page
 * repaints, and the user's pointer and keys come back as input events. The
 * user acts directly on the page; this is not an agent action, so it does not
 * go through `browser/pre-action`.
 */

export type BrowserLiveEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'state'; url: string; title: string }

/** Pointer positions are fractions of the frame (0–1), so the UI can scale it freely. */
export type BrowserLiveInput =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; text: string }

export type BrowserLiveCommand = 'back' | 'forward' | 'reload'

export interface LiveViewOptions {
  /** JPEG quality of screencast frames, 1–100. */
  quality?: number
  /** Frames are scaled down to fit this box. */
  maxWidth?: number
  maxHeight?: number
}

const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))

export function parseLiveInput(value: unknown): BrowserLiveInput | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const x = clamp(Number(record.x))
  const y = clamp(Number(record.y))
  switch (record.kind) {
    case 'click': {
      const button = record.button === 'right' || record.button === 'middle' ? record.button : 'left'
      const clickCount = record.clickCount === 2 ? 2 : 1
      return { kind: 'click', x, y, button, clickCount }
    }
    case 'move':
      return { kind: 'move', x, y }
    case 'wheel':
      return { kind: 'wheel', x, y, deltaX: Number(record.deltaX) || 0, deltaY: Number(record.deltaY) || 0 }
    case 'key':
      return typeof record.key === 'string' && record.key.length > 0 && record.key.length <= 40 ? { kind: 'key', key: record.key } : undefined
    case 'text':
      return typeof record.text === 'string' && record.text.length <= 10_000 ? { kind: 'text', text: record.text } : undefined
    default:
      return undefined
  }
}

/** One screencast shared by every subscriber; it runs only while someone watches. */
export class LiveView {
  private readonly _listeners = new Set<(event: BrowserLiveEvent) => void>()
  private _session: CDPSession | undefined
  private _page: Page | undefined
  private _viewport = { width: 1280, height: 800 }
  private _starting: Promise<void> | undefined

  constructor(private readonly _acquire: () => Promise<Page>, private readonly _options: LiveViewOptions = {}) {}

  subscribe(listener: (event: BrowserLiveEvent) => void): () => void {
    this._listeners.add(listener)
    void this._ensure().catch(() => {})
    return () => {
      this._listeners.delete(listener)
      if (this._listeners.size === 0) void this._stop()
    }
  }

  /** The driven page changed (closed, relaunched): move the screencast to it. */
  async follow(page: Page): Promise<void> {
    if (this._page === page) return
    await this._stop()
    if (this._listeners.size) await this._ensure()
  }

  /** Re-announce the page after navigation. */
  emitState(state: { url: string; title: string }): void {
    this._emit({ type: 'state', ...state })
  }

  async input(event: BrowserLiveInput): Promise<void> {
    const page = await this._acquire()
    const at = (x: number, y: number) => [x * this._viewport.width, y * this._viewport.height] as const
    switch (event.kind) {
      case 'click': {
        const [x, y] = at(event.x, event.y)
        await page.mouse.click(x, y, { button: event.button ?? 'left', clickCount: event.clickCount ?? 1 })
        return
      }
      case 'move': {
        const [x, y] = at(event.x, event.y)
        await page.mouse.move(x, y)
        return
      }
      case 'wheel': {
        const [x, y] = at(event.x, event.y)
        await page.mouse.move(x, y)
        await page.mouse.wheel(event.deltaX, event.deltaY)
        return
      }
      case 'key':
        await page.keyboard.press(event.key)
        return
      case 'text':
        await page.keyboard.insertText(event.text)
    }
  }

  async close(): Promise<void> {
    this._listeners.clear()
    await this._stop()
  }

  private _emit(event: BrowserLiveEvent): void {
    for (const listener of this._listeners) listener(event)
  }

  private _ensure(): Promise<void> {
    if (this._session) return Promise.resolve()
    this._starting ??= this._start().finally(() => { this._starting = undefined })
    return this._starting
  }

  private async _start(): Promise<void> {
    const page = await this._acquire()
    const session = await page.context().newCDPSession(page)
    this._page = page
    this._session = session
    const size = page.viewportSize() ?? await page.evaluate<{ width: number; height: number }>('({ width: innerWidth, height: innerHeight })')
    this._viewport = size
    session.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      this._viewport = { width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight }
      this._emit({ type: 'frame', data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight })
      void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
    })
    page.once('close', () => { if (this._page === page) void this._stop() })
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this._options.quality ?? 70,
      maxWidth: this._options.maxWidth ?? 1600,
      maxHeight: this._options.maxHeight ?? 1200,
    })
    this._emit({ type: 'state', url: page.url(), title: await page.title().catch(() => '') })
  }

  private async _stop(): Promise<void> {
    const session = this._session
    this._session = undefined
    this._page = undefined
    if (!session) return
    await session.send('Page.stopScreencast').catch(() => {})
    await session.detach().catch(() => {})
  }
}
