import type { CDPSession, Page } from 'playwright-core'
import type { BrowserTab } from '@tnega/browser'

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
  | { type: 'tabs'; tabs: BrowserTab[] }

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
  /** Frame rate cap for the UI. Animated pages (carousels, ads) repaint far
   * faster than a viewer can read, and every frame costs a JPEG decode and a
   * repaint on the client; defaults to 15. */
  maxFps?: number
}

const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))

export const DEFAULT_MAX_FPS = 15

/** How many times a start that lost the navigation race retries before giving up. */
const MAX_START_RETRIES = 3
/** Backoff between those attempts; multiplied by the attempt number. */
const RETRY_DELAY_MS = 250

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

/** One screencast shared by every subscriber; it runs only while someone watches. */export class LiveView {
  private readonly _listeners = new Set<(event: BrowserLiveEvent) => void>()
  /** Listeners that want screencast frames; the others only follow tabs and state. */
  private readonly _watchers = new Set<(event: BrowserLiveEvent) => void>()
  private _session: CDPSession | undefined
  private _page: Page | undefined
  private _viewport = { width: 1280, height: 800 }
  private _starting: Promise<void> | undefined
  private _pendingFrame: { data: string; width: number; height: number; sessionId: number } | undefined
  private _frameTimer: ReturnType<typeof setTimeout> | undefined
  /** A start was requested while one was running (the driven page changed). */
  private _restart = false
  private _retries = 0
  private _retryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly _acquire: () => Promise<Page>, private readonly _options: LiveViewOptions = {}) {}

  subscribe(listener: (event: BrowserLiveEvent) => void, options: { frames?: boolean } = {}): () => void {
    this._listeners.add(listener)
    if (options.frames !== false) {
      this._watchers.add(listener)
      // A new watcher gets a fresh chance: the UI opened a panel that must show the page.
      this._retries = 0
      void this._ensure().catch(() => {})
    } else {
      void this._acquire().catch(() => {})
    }
    return () => {
      this._listeners.delete(listener)
      this._watchers.delete(listener)
      if (this._watchers.size === 0) void this._stop()
    }
  }

  /** The driven page changed (closed, relaunched): move the screencast to it. */
  async follow(page: Page): Promise<void> {
    if (this._page === page) return
    // A screencast that is starting picks up the active page itself; waiting for
    // it here would deadlock, since starting is what selected this page.
    if (this._starting) return
    await this._stop()
    if (this._watchers.size) void this._ensure().catch(() => {})
  }

  /** Announce the tab list after any change. */
  emitTabs(tabs: BrowserTab[]): void {
    this._emit({ type: 'tabs', tabs })
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
    this._watchers.clear()
    await this._stop()
  }

  private _emit(event: BrowserLiveEvent): void {
    for (const listener of this._listeners) listener(event)
  }

  private _ensure(): Promise<void> {
    if (this._session) return Promise.resolve()
    if (this._starting) return this._starting
    this._starting = this._start()
      .then(
        () => { this._retries = 0 },
        (error: unknown) => {
          // Starting loses a race with navigation: `Page.startScreencast` answers "Not
          // attached to an active page" when the renderer is being replaced. Nobody is
          // left to retry — the UI only called subscribe() once — so do it here, or the
          // panel stays black for the rest of the session.
          if (this._watchers.size > 0) this._retry()
          throw error
        },
      )
      .finally(() => {
        this._starting = undefined
        if (this._restart) {
          this._restart = false
          if (this._watchers.size > 0) void this._ensure().catch(() => {})
        }
      })
    return this._starting
  }

  private _retry(): void {
    if (this._retryTimer) return
    if (this._retries >= MAX_START_RETRIES) return
    this._retries += 1
    this._retryTimer = setTimeout(() => {
      this._retryTimer = undefined
      if (this._session || this._watchers.size === 0) return
      void this._ensure().catch(() => {})
    }, RETRY_DELAY_MS * this._retries)
    this._retryTimer.unref?.()
  }

  private async _start(): Promise<void> {
    const page = await this._acquire()
    const session = await page.context().newCDPSession(page)
    try {
      const size = page.viewportSize() ?? await page.evaluate<{ width: number; height: number }>('({ width: innerWidth, height: innerHeight })')
      this._viewport = size
      const interval = 1000 / Math.max(1, this._options.maxFps ?? DEFAULT_MAX_FPS)
      let lastEmittedAt = 0
      const flush = () => {
        this._frameTimer = undefined
        const frame = this._pendingFrame
        this._pendingFrame = undefined
        if (!frame) return
        this._viewport = { width: frame.width, height: frame.height }
        const event = { type: 'frame' as const, data: frame.data, width: frame.width, height: frame.height }
        lastEmittedAt = Date.now()
        for (const listener of this._watchers) listener(event)
        // Acknowledging is what asks Chromium for the next frame; holding the ack
        // until this one is delivered keeps at most one frame in flight, so an
        // animated page costs the UI the frame rate below instead of the page's.
        void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      }
      session.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
        this._pendingFrame = {
          data: frame.data,
          width: frame.metadata.deviceWidth,
          height: frame.metadata.deviceHeight,
          sessionId: frame.sessionId,
        }
        if (this._frameTimer) return
        const wait = Math.max(0, interval - (Date.now() - lastEmittedAt))
        this._frameTimer = setTimeout(flush, wait)
      })
      page.once('close', () => { if (this._page === page) void this._stop() })
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this._options.quality ?? 60,
        maxWidth: this._options.maxWidth ?? 1280,
        maxHeight: this._options.maxHeight ?? 800,
      })
      // Published only once the screencast really runs: `_ensure()` treats a set
      // `_session` as "already started", so a half-started one would never retry.
      this._page = page
      this._session = session
    } catch (error) {
      // `startScreencast` failed (usually because the page navigated onto a new
      // renderer): drop the session so the next attempt starts clean.
      await session.detach().catch(() => undefined)
      throw error
    }
    this._emit({ type: 'state', url: page.url(), title: await page.title().catch(() => '') })
    // The active tab may have changed while starting; follow it.
    const current = await this._acquire().catch(() => page)
    if (current !== page) {
      await this._stop()
      // Still inside `_start()`, so ask the owner of `_starting` to go again rather
      // than calling `_ensure()` here — that would await the promise we are in.
      if (this._watchers.size) this._restart = true
    }
  }

  private async _stop(): Promise<void> {
    if (this._frameTimer) {
      clearTimeout(this._frameTimer)
      this._frameTimer = undefined
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer)
      this._retryTimer = undefined
    }
    this._pendingFrame = undefined
    const session = this._session
    this._session = undefined
    this._page = undefined
    if (!session) return
    await session.send('Page.stopScreencast').catch(() => {})
    await session.detach().catch(() => {})
  }
}
