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
  type BrowserTab,
} from '@tnega/browser'
import { LiveView, type BrowserLiveCommand, type LiveViewOptions } from './live.js'
import { PICK_CANCEL_SOURCE, PICK_SOURCE, pickClip, type PickedElement } from './picker.js'
import type { PageSource } from './source.js'

export interface BrowserHostOptions {
  snapshotMaxChars?: number
  actionTimeoutMs?: number
  logLimit?: number
  /** JPEG quality for screenshots, 1–100. */
  screenshotQuality?: number
  /** Console messages to drop, e.g. warnings the embedding host prints into every page. */
  ignoreConsole?: (text: string) => boolean
  live?: LiveViewOptions
}

export interface PickResult {
  element: PickedElement
  /** The element and a little around it, as JPEG. */
  image?: { mediaType: 'image/jpeg'; data: string }
}

const WAIT_MS_CAP = 10_000

/** Interactions that usually change the page in place (menus, dropdowns, validation). */
const SETTLING_OPS = new Set(['click', 'hover', 'type', 'select', 'press'])

/**
 * Resolves once the DOM has been quiet for `quiet` ms, or after `cap` ms.
 * Menus and dropdowns often open a tick after the click (state updates,
 * timers, animations); without this the next snapshot misses them and the
 * agent clicks the trigger again, closing what it just opened.
 */
export function settleSource(quiet = 150, cap = 1_500): string {
  return `new Promise(resolve => {
  let timer
  const done = () => { observer.disconnect(); clearTimeout(timer); clearTimeout(limit); resolve(undefined) }
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, ${quiet}) })
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  timer = setTimeout(done, ${quiet})
  const limit = setTimeout(done, ${cap})
})`
}

interface SelectLike {
  tagName: string
  options?: ArrayLike<{ label: string; value: string; selected: boolean }>
}

/** Runs in the page: labels of a native <select>'s options, or null when the element is not one. */
function selectOptions(element: SelectLike): string[] | null {
  if (element.tagName !== 'SELECT' || !element.options) return null
  return Array.from(element.options, option => (option.selected ? '* ' : '') + (option.label || option.value))
}

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

function isPicked(value: unknown): value is PickedElement {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.tag === 'string' && typeof record.selector === 'string' && typeof record.rect === 'object' && record.rect !== null
}

interface Tab {
  id: string
  page: Page
  title: string
}

/**
 * Owns the driven tabs and what has been observed on them. Long-lived: the
 * web server keeps one per browser so tabs, console and network history
 * survive runs. Actions, observations and the live view follow the active tab.
 */
export class PlaywrightBrowserHost {
  private _tabs: Tab[] = []
  private _active: string | undefined
  private _nextTab = 1
  private _console: BrowserConsoleEntry[] = []
  private _network: BrowserNetworkEntry[] = []
  private _starting: Promise<Page> | undefined
  private _viewport: { width: number; height: number } | undefined
  private readonly _snapshotMaxChars: number
  private readonly _actionTimeoutMs: number
  private readonly _logLimit: number
  private readonly _quality: number
  private readonly _ignoreConsole: ((text: string) => boolean) | undefined
  /** Screencast and user input for UIs that show the page themselves. */
  readonly live: LiveView

  constructor(private readonly _source: PageSource, options: BrowserHostOptions = {}) {
    this._snapshotMaxChars = options.snapshotMaxChars ?? DEFAULT_BROWSER_SNAPSHOT_MAX_CHARS
    this._actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS
    this._logLimit = options.logLimit ?? DEFAULT_BROWSER_LOG_LIMIT
    this._quality = options.screenshotQuality ?? 70
    this._ignoreConsole = options.ignoreConsole
    this.live = new LiveView(() => this.page(), options.live)
    this._source.onPopup?.(page => {
      this._adopt(page)
      void this._select(this._tabs.at(-1)!.id)
    })
  }

  // -------------------------------------------------------------------------
  // Tabs

  tabs(): BrowserTab[] {
    return this._tabs.map(tab => ({ id: tab.id, url: tab.page.url(), title: tab.title, active: tab.id === this._active }))
  }

  /** The active page, starting the browser if nothing is open yet. */
  async page(): Promise<Page> {
    const active = this._tabs.find(tab => tab.id === this._active)
    if (active && !active.page.isClosed()) return active.page
    const open = this._tabs.find(tab => !tab.page.isClosed())
    if (open) {
      await this._select(open.id)
      return open.page
    }
    this._starting ??= this._source.acquire().then(async page => {
      const tab = this._adopt(page)
      await this._select(tab.id)
      return page
    }).finally(() => { this._starting = undefined })
    return this._starting
  }

  async newTab(url?: string): Promise<BrowserTab> {
    await this.page()
    const tab = this._adopt(await this._source.open())
    await this._select(tab.id)
    if (url) await tab.page.goto(normalizeBrowserUrl(url), { waitUntil: 'domcontentloaded', timeout: this._actionTimeoutMs }).catch(() => {})
    this._announce()
    return this.tabs().find(entry => entry.id === tab.id)!
  }

  async selectTab(id: string): Promise<void> {
    if (!this._tabs.some(tab => tab.id === id)) throw new BrowserError('BROWSER_FAILED', `no tab ${id}; see browser_tabs`)
    await this._select(id)
  }

  async closeTab(id = this._active): Promise<void> {
    const index = this._tabs.findIndex(tab => tab.id === id)
    if (index < 0) throw new BrowserError('BROWSER_FAILED', `no tab ${String(id)}; see browser_tabs`)
    const [tab] = this._tabs.splice(index, 1)
    await this._source.closePage(tab!.page)
    if (!this._tabs.length) {
      // Never leave the browser without a tab: start over with a blank one.
      this._active = undefined
      await this.page()
      this._announce()
      return
    }
    if (tab!.id === this._active) await this._select(this._tabs[Math.min(index, this._tabs.length - 1)]!.id)
    else this._announce()
  }

  // -------------------------------------------------------------------------
  // The user, through a UI

  state(): BrowserPageState {
    const active = this._tabs.find(tab => tab.id === this._active)
    return active ? { url: active.page.url(), title: active.title } : { url: 'about:blank', title: '' }
  }

  /** The user typed an address or pressed back / forward / reload in the UI. */
  async userNavigate(url: string): Promise<void> {
    const page = await this.page()
    await page.goto(normalizeBrowserUrl(url), { waitUntil: 'domcontentloaded', timeout: this._actionTimeoutMs }).catch(() => {})
    await this._refresh(page)
  }

  async userCommand(command: BrowserLiveCommand): Promise<void> {
    const page = await this.page()
    const options = { waitUntil: 'domcontentloaded' as const, timeout: this._actionTimeoutMs }
    if (command === 'back') await page.goBack(options).catch(() => null)
    if (command === 'forward') await page.goForward(options).catch(() => null)
    if (command === 'reload') await page.reload(options).catch(() => null)
    await this._refresh(page)
  }

  /**
   * Make every tab render at the size the UI shows it, so the page fills the
   * panel. The desktop view sizes itself; only screencast UIs call this.
   */
  async setViewport(width: number, height: number): Promise<void> {
    const size = { width: Math.max(200, Math.round(width)), height: Math.max(150, Math.round(height)) }
    if (this._viewport && this._viewport.width === size.width && this._viewport.height === size.height) return
    this._viewport = size
    await Promise.all(this._tabs.filter(tab => !tab.page.isClosed()).map(tab => tab.page.setViewportSize(size).catch(() => {})))
  }

  /** Let the user point at an element; resolves when they click it, or undefined if cancelled. */
  async pick(): Promise<PickResult | undefined> {
    const page = await this.page()
    await this._source.prepare?.(page)
    const picked: unknown = await page.evaluate(PICK_SOURCE)
    if (!isPicked(picked)) return undefined
    const viewport = page.viewportSize() ?? await page.evaluate<{ width: number; height: number }>('({ width: innerWidth, height: innerHeight })')
    const clip = pickClip(picked.rect, viewport)
    const bytes = clip ? await page.screenshot({ type: 'jpeg', quality: 85, clip, timeout: this._actionTimeoutMs }).catch(() => undefined) : undefined
    return { element: picked, ...(bytes ? { image: { mediaType: 'image/jpeg' as const, data: bytes.toString('base64') } } : {}) }
  }

  async cancelPick(): Promise<void> {
    const active = this._tabs.find(tab => tab.id === this._active)
    await active?.page.evaluate(PICK_CANCEL_SOURCE).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // The agent, through the browser seam

  async run(action: BrowserAction, options: BrowserCallOptions = {}): Promise<BrowserActionResult> {
    try {
      if (action.op === 'tab_new') {
        const tab = await this.newTab(action.url)
        return { url: tab.url, title: tab.title, note: `opened tab ${tab.id}` }
      }
      if (action.op === 'tab_select') {
        await this.selectTab(action.id)
        return { ...this.state(), note: `switched to tab ${action.id}` }
      }
      if (action.op === 'tab_close') {
        await this.closeTab(action.id)
        return { ...this.state(), note: `closed tab; now on ${this._active}` }
      }
      const page = await this.page()
      await this._source.prepare?.(page)
      const note = await withSignal(this._perform(page, action), options.signal)
      await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {})
      // A navigation can replace the document mid-wait; that is settled enough.
      if (SETTLING_OPS.has(action.op)) await withSignal(page.evaluate(settleSource()), options.signal).catch(() => {})
      await this._refresh(page)
      return { ...this.state(), ...(note ? { note } : {}) }
    } catch (error) {
      throw toBrowserError(error)
    }
  }

  async snapshot(options: BrowserCallOptions = {}): Promise<BrowserSnapshot> {
    try {
      const page = await this.page()
      const text = await withSignal(page.ariaSnapshot({ mode: 'ai', timeout: this._actionTimeoutMs }), options.signal)
      await this._refresh(page)
      const truncated = text.length > this._snapshotMaxChars
      return {
        ...this.state(),
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
      await this._refresh(page)
      return { ...this.state(), mediaType: 'image/jpeg', data: bytes.toString('base64') }
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
    await this.live.close()
    this._tabs = []
    this._active = undefined
    await this._source.release()
  }

  // -------------------------------------------------------------------------

  private _adopt(page: Page): Tab {
    const existing = this._tabs.find(tab => tab.page === page)
    if (existing) return existing
    const tab: Tab = { id: `t${this._nextTab++}`, page, title: '' }
    this._tabs.push(tab)
    this._watch(tab)
    if (this._viewport) void page.setViewportSize(this._viewport).catch(() => {})
    this._announce()
    return tab
  }

  private async _select(id: string): Promise<void> {
    const tab = this._tabs.find(entry => entry.id === id)
    if (!tab) return
    this._active = id
    await this._source.activate?.(tab.page)
    await this.live.follow(tab.page).catch(() => {})
    await this._refresh(tab.page)
  }

  private _announce(): void {
    this.live.emitTabs(this.tabs())
  }

  private async _refresh(page: Page): Promise<void> {
    const tab = this._tabs.find(entry => entry.page === page)
    if (tab) tab.title = await page.title().catch(() => tab.title)
    if (tab?.id === this._active) this.live.emitState(this.state())
    this._announce()
  }

  private async _perform(page: Page, action: Exclude<BrowserAction, { op: 'tab_new' | 'tab_select' | 'tab_close' }>): Promise<string | undefined> {
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
        // A native <select> opens an OS popup that screenshots and the live view
        // never show and whose options have no refs; choose with browser_select_option.
        const choices = action.button === undefined || action.button === 'left'
          ? await locator.evaluate(selectOptions).catch(() => null)
          : undefined
        if (choices) {
          await locator.focus({ timeout }).catch(() => {})
          return `this is a <select>; clicking does not open it here. Use browser_select_option with one of: ${choices.join(', ')} (* = selected)`
        }
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

  private _watch(tab: Tab): void {
    const { page } = tab
    const push = <T>(list: T[], entry: T) => {
      list.push(entry)
      if (list.length > this._logLimit) list.splice(0, list.length - this._logLimit)
    }
    page.on('load', () => { void this._refresh(page) })
    page.on('domcontentloaded', () => { void this._refresh(page) })
    page.on('console', (entry: ConsoleMessage) => {
      if (this._ignoreConsole?.(entry.text())) return
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
      if (frame !== page.mainFrame()) return
      if (tab.id === this._active) this.live.emitState(this.state())
      this._announce()
    })
    page.on('close', () => {
      const index = this._tabs.indexOf(tab)
      if (index < 0) return
      this._tabs.splice(index, 1)
      if (this._active === tab.id) {
        this._active = undefined
        const next = this._tabs[Math.min(index, this._tabs.length - 1)]
        if (next) void this._select(next.id)
      }
      this._announce()
    })
  }
}
