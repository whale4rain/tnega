import type { ConsoleMessage, Locator, Page, Request } from 'playwright-core'
import {
  BrowserError,
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_LOG_LIMIT,
  DEFAULT_BROWSER_SNAPSHOT_MAX_CHARS,
  normalizeBrowserUrl,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserCallOptions,
  type BrowserConsoleEntry,
  type BrowserLogQuery,
  type BrowserNetworkEntry,
  type BrowserPageState,
  type BrowserScreenshot,
  type BrowserSnapshot,
} from '@tnega/browser'
import type { PageSource } from './source.js'

export interface BrowserHostOptions {
  snapshotMaxChars?: number
  actionTimeoutMs?: number
  logLimit?: number
  /** JPEG quality for screenshots, 1–100. */
  screenshotQuality?: number
}

const WAIT_MS_CAP = 10_000

function message(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]! : String(error)
}

/** Map Playwright failures onto the seam's stable codes. */
function toBrowserError(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error
  if (error instanceof Error && error.name === 'TimeoutError') return new BrowserError('BROWSER_TIMEOUT', message(error), { cause: error })
  if (error instanceof Error && error.name === 'AbortError') return new BrowserError('BROWSER_ABORTED', 'browser action was cancelled', { cause: error })
  return new BrowserError('BROWSER_FAILED', message(error), { cause: error })
}

function withSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new BrowserError('BROWSER_ABORTED', 'browser action was cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new BrowserError('BROWSER_ABORTED', 'browser action was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Wrap an expression or function source so `page.evaluate` returns its (awaited) value. */
export function evaluationSource(expression: string): string {
  const source = expression.trim()
  const isFunction = /^(?:async\s+)?function\b/u.test(source)
    || /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u.test(source)
  return isFunction ? `(${source})()` : `(async () => (${source}))()`
}

/**
 * Owns one driven page and what has been observed on it. Long-lived: the web
 * server keeps one per browser so console and network history survive runs.
 */
export class PlaywrightBrowserHost {
  private _page: Page | undefined
  private _state: BrowserPageState = { url: 'about:blank', title: '' }
  private _console: BrowserConsoleEntry[] = []
  private _network: BrowserNetworkEntry[] = []
  private _pending: Promise<Page> | undefined
  private readonly _snapshotMaxChars: number
  private readonly _actionTimeoutMs: number
  private readonly _logLimit: number
  private readonly _quality: number

  constructor(private readonly _source: PageSource, options: BrowserHostOptions = {}) {
    this._snapshotMaxChars = options.snapshotMaxChars ?? DEFAULT_BROWSER_SNAPSHOT_MAX_CHARS
    this._actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS
    this._logLimit = options.logLimit ?? DEFAULT_BROWSER_LOG_LIMIT
    this._quality = options.screenshotQuality ?? 70
  }

  state(): BrowserPageState {
    return { ...this._state }
  }

  async page(): Promise<Page> {
    if (this._page && !this._page.isClosed()) return this._page
    this._pending ??= this._source.acquire().then(page => {
      this._watch(page)
      return page
    }).finally(() => {
      this._pending = undefined
    })
    return this._pending
  }

  async run(action: BrowserAction, options: BrowserCallOptions = {}): Promise<BrowserActionResult> {
    try {
      const page = await this.page()
      await this._source.prepare?.(page)
      const note = await withSignal(this._perform(page, action), options.signal)
      await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {})
      await this._refreshState(page)
      return { ...this._state, ...(note ? { note } : {}) }
    } catch (error) {
      throw toBrowserError(error)
    }
  }

  async snapshot(options: BrowserCallOptions = {}): Promise<BrowserSnapshot> {
    try {
      const page = await this.page()
      const text = await withSignal(page.ariaSnapshot({ mode: 'ai', timeout: this._actionTimeoutMs }), options.signal)
      await this._refreshState(page)
      const truncated = text.length > this._snapshotMaxChars
      return {
        ...this._state,
        snapshot: truncated
          ? `${text.slice(0, this._snapshotMaxChars)}\n… (snapshot truncated; scroll or narrow the page to see more)`
          : text,
        truncated,
      }
    } catch (error) {
      throw toBrowserError(error)
    }
  }

  async screenshot(options: BrowserCallOptions & { fullPage?: boolean; ref?: string } = {}): Promise<BrowserScreenshot> {
    try {
      const page = await this.page()
      await this._source.prepare?.(page)
      const shot = { type: 'jpeg' as const, quality: this._quality, timeout: this._actionTimeoutMs }
      const bytes = options.ref
        ? await withSignal(this._locate(page, options.ref).then(locator => locator.screenshot(shot)), options.signal)
        : await withSignal(page.screenshot({ ...shot, fullPage: options.fullPage ?? false }), options.signal)
      await this._refreshState(page)
      return { ...this._state, mediaType: 'image/jpeg', data: bytes.toString('base64') }
    } catch (error) {
      throw toBrowserError(error)
    }
  }

  console(query: BrowserLogQuery = {}): BrowserConsoleEntry[] {
    const entries = this._console.filter(entry => (query.since === undefined || entry.time > query.since)
      && (!query.onlyProblems || entry.type === 'error' || entry.type === 'warning'))
    return entries.slice(-(query.limit ?? this._logLimit))
  }

  network(query: BrowserLogQuery = {}): BrowserNetworkEntry[] {
    const entries = this._network.filter(entry => (query.since === undefined || entry.time > query.since)
      && (!query.onlyProblems || entry.failure !== undefined || (entry.status ?? 0) >= 400))
    return entries.slice(-(query.limit ?? this._logLimit))
  }

  async evaluate(expression: string, options: BrowserCallOptions = {}): Promise<unknown> {
    try {
      const page = await this.page()
      return await withSignal(page.evaluate(evaluationSource(expression)), options.signal)
    } catch (error) {
      throw toBrowserError(error)
    }
  }

  async close(): Promise<void> {
    this._page = undefined
    await this._source.release()
  }

  private async _perform(page: Page, action: BrowserAction): Promise<string | undefined> {
    const timeout = this._actionTimeoutMs
    switch (action.op) {
      case 'navigate': {
        const response = await page.goto(normalizeBrowserUrl(action.url), { waitUntil: 'domcontentloaded', timeout })
        return response ? `HTTP ${response.status()}` : undefined
      }
      case 'back':
        return (await page.goBack({ waitUntil: 'domcontentloaded', timeout })) ? undefined : 'no previous page'
      case 'forward':
        return (await page.goForward({ waitUntil: 'domcontentloaded', timeout })) ? undefined : 'no next page'
      case 'reload':
        await page.reload({ waitUntil: 'domcontentloaded', timeout })
        return undefined
      case 'click': {
        const locator = await this._locate(page, action.ref)
        await locator.click({ button: action.button ?? 'left', clickCount: action.doubleClick ? 2 : 1, timeout })
        return undefined
      }
      case 'hover':
        await (await this._locate(page, action.ref)).hover({ timeout })
        return undefined
      case 'type': {
        const locator = await this._locate(page, action.ref)
        await locator.fill(action.text, { timeout })
        if (action.submit) await locator.press('Enter', { timeout })
        return undefined
      }
      case 'select': {
        const selected = await (await this._locate(page, action.ref)).selectOption(action.values, { timeout })
        return `selected ${selected.join(', ') || 'nothing'}`
      }
      case 'press':
        await page.keyboard.press(action.key)
        return undefined
      case 'scroll':
        await page.mouse.wheel(action.deltaX ?? 0, action.deltaY)
        return undefined
      case 'wait':
        if (action.text !== undefined) {
          await page.getByText(action.text).first().waitFor({ state: 'visible', timeout })
        } else if (action.textGone !== undefined) {
          await page.getByText(action.textGone).first().waitFor({ state: 'hidden', timeout })
        } else {
          await page.waitForTimeout(Math.min(Math.max(action.ms ?? 1_000, 0), WAIT_MS_CAP))
        }
        return undefined
      case 'resize':
        await page.setViewportSize({ width: Math.round(action.width), height: Math.round(action.height) })
        return `viewport ${Math.round(action.width)}x${Math.round(action.height)}`
    }
  }

  private async _locate(page: Page, ref: string): Promise<Locator> {
    if (!/^[A-Za-z0-9_-]+$/u.test(ref)) throw new BrowserError('BROWSER_STALE_REF', `"${ref}" is not a snapshot ref; use an id like e12 from browser_snapshot`)
    const locator = page.locator(`aria-ref=${ref}`)
    const count = await locator.count().catch(() => 0)
    if (count === 0) throw new BrowserError('BROWSER_STALE_REF', `ref ${ref} is not on the page any more; take a new snapshot`)
    return locator.first()
  }

  private async _refreshState(page: Page): Promise<void> {
    this._state = { url: page.url(), title: await page.title().catch(() => this._state.title) }
  }

  private _watch(page: Page): void {
    this._page = page
    this._state = { url: page.url(), title: '' }
    const push = <T>(list: T[], entry: T) => {
      list.push(entry)
      if (list.length > this._logLimit) list.splice(0, list.length - this._logLimit)
    }
    page.on('console', (entry: ConsoleMessage) => {
      const { url, lineNumber, columnNumber } = entry.location()
      push(this._console, {
        type: entry.type(),
        text: entry.text(),
        ...(url ? { location: `${url}:${lineNumber + 1}:${columnNumber + 1}` } : {}),
        time: Date.now(),
      })
    })
    page.on('pageerror', error => {
      push(this._console, { type: 'error', text: `Uncaught ${error.name}: ${error.message}`, time: Date.now() })
    })
    const record = (request: Request, failure?: string) => {
      const response = failure === undefined ? request.response() : Promise.resolve(null)
      void response.then(result => push(this._network, {
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        ...(result ? { status: result.status() } : {}),
        ...(failure !== undefined ? { failure } : {}),
        time: Date.now(),
      }), () => {})
    }
    page.on('requestfinished', request => record(request))
    page.on('requestfailed', request => record(request, request.failure()?.errorText ?? 'failed'))
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) this._state = { url: frame.url(), title: this._state.title }
    })
    page.on('close', () => {
      if (this._page === page) this._page = undefined
    })
  }
}
