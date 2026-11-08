import type { Context } from '@tnega/core'
import {
  BrowserError,
  BrowserService,
  DEFAULT_BROWSER_LOG_LIMIT,
  queryConsole,
  queryNetwork,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserCallOptions,
  type BrowserConsoleEntry,
  type BrowserErrorCode,
  type BrowserLogQuery,
  type BrowserNetworkEntry,
  type BrowserPageState,
  type BrowserScreenshot,
  type BrowserSnapshot,
  type BrowserTab,
} from '@tnega/browser'
import { RemoteError, forwardService, type DaemonLink, type RemoteStream, type ServiceForwarder } from '@tnega/daemon-protocol'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPage(value: unknown): value is BrowserPageState {
  return isRecord(value) && typeof value.url === 'string' && typeof value.title === 'string'
}

function isTab(value: unknown): value is BrowserTab {
  return isPage(value) && isRecord(value) && typeof value.id === 'string' && typeof value.active === 'boolean'
}

function isConsoleEntry(value: unknown): value is BrowserConsoleEntry {
  return isRecord(value) && typeof value.type === 'string' && typeof value.text === 'string' && typeof value.time === 'number'
    && (value.location === undefined || typeof value.location === 'string')
}

function isNetworkEntry(value: unknown): value is BrowserNetworkEntry {
  return isRecord(value) && typeof value.method === 'string' && typeof value.url === 'string'
    && typeof value.resourceType === 'string' && typeof value.time === 'number'
    && (value.status === undefined || typeof value.status === 'number')
    && (value.failure === undefined || typeof value.failure === 'string')
}

const CODES: ReadonlySet<string> = new Set<BrowserErrorCode>([
  'BROWSER_UNAVAILABLE', 'BROWSER_STALE_REF', 'BROWSER_DENIED', 'BROWSER_TIMEOUT', 'BROWSER_ABORTED', 'BROWSER_FAILED',
])

function isCode(value: unknown): value is BrowserErrorCode {
  return typeof value === 'string' && CODES.has(value)
}

/** A `BrowserError` from the daemon comes back as one, with its code, so tools tell the model the same thing. */
function local(error: unknown): unknown {
  if (error instanceof RemoteError) {
    if (error.name === 'BrowserError' && isCode(error.code)) return new BrowserError(error.code, error.message)
    if (error.name === 'AbortError') return new BrowserError('BROWSER_ABORTED', error.message)
    return new BrowserError('BROWSER_FAILED', `the daemon's browser failed: ${error.message}`, { cause: error })
  }
  return error
}

function malformed(what: string): BrowserError {
  return new BrowserError('BROWSER_FAILED', `the daemon sent a malformed ${what}`)
}

/**
 * `ctx.browser` on a daemon. Every action and observation is one forwarded
 * call; the synchronous reads come from a cache the daemon's `watch` stream
 * keeps current (page, tabs, console and network entries).
 */
export class RemoteBrowser extends BrowserService {
  private readonly remote: ServiceForwarder
  private current: BrowserPageState = { url: 'about:blank', title: '' }
  private openTabs: BrowserTab[] = []
  private readonly consoleLog: BrowserConsoleEntry[] = []
  private readonly networkLog: BrowserNetworkEntry[] = []
  private watching: RemoteStream | undefined

  constructor(ctx: Context, link: DaemonLink, private readonly logLimit = DEFAULT_BROWSER_LOG_LIMIT) {
    super(ctx)
    if (!link.capabilities.services?.includes('browser')) {
      throw new BrowserError('BROWSER_UNAVAILABLE', `daemon ${link.deviceId} does not serve a browser; start it with --browser`)
    }
    this.remote = forwardService(link, 'browser')
  }

  /** Follow the daemon's page, tabs and logs. Called once when mounted. */
  async watch(): Promise<void> {
    this.watching = await this.guarded(() => this.remote.stream('watch', [], { onEvent: event => this.apply(event) }))
  }

  async unwatch(): Promise<void> {
    await this.watching?.close()
    this.watching = undefined
  }

  private apply(event: unknown): void {
    if (!isRecord(event)) return
    if (event.type === 'state' && isPage(event)) this.current = { url: event.url, title: event.title }
    else if (event.type === 'tabs' && Array.isArray(event.tabs)) this.openTabs = event.tabs.filter(isTab)
    else if (event.type === 'log' && event.kind === 'console' && isConsoleEntry(event.entry)) this.keep(this.consoleLog, event.entry)
    else if (event.type === 'log' && event.kind === 'network' && isNetworkEntry(event.entry)) this.keep(this.networkLog, event.entry)
  }

  private keep<T>(list: T[], entry: T): void {
    list.push(entry)
    if (list.length > this.logLimit) list.splice(0, list.length - this.logLimit)
  }

  private async guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      throw local(error)
    }
  }

  private async call(method: string, args: unknown[], options: BrowserCallOptions = {}): Promise<unknown> {
    return await this.guarded(() => this.remote.call(method, args, options.signal ? { signal: options.signal } : {}))
  }

  page(): BrowserPageState {
    return { ...this.current }
  }

  tabs(): BrowserTab[] {
    return this.openTabs.map(tab => ({ ...tab }))
  }

  protected async runAction(action: BrowserAction, options: BrowserCallOptions): Promise<BrowserActionResult> {
    const result = await this.call('run', [action], options)
    if (!isPage(result) || !isRecord(result) || (result.note !== undefined && typeof result.note !== 'string')) throw malformed('action result')
    // The watch stream follows soon; the page an action reports is already known.
    this.current = { url: result.url, title: result.title }
    return { url: result.url, title: result.title, ...(typeof result.note === 'string' ? { note: result.note } : {}) }
  }

  async snapshot(options?: BrowserCallOptions): Promise<BrowserSnapshot> {
    const result = await this.call('snapshot', [], options)
    if (!isPage(result) || !isRecord(result) || typeof result.snapshot !== 'string' || typeof result.truncated !== 'boolean') throw malformed('snapshot')
    return { url: result.url, title: result.title, snapshot: result.snapshot, truncated: result.truncated }
  }

  async screenshot(options: BrowserCallOptions & { fullPage?: boolean; ref?: string } = {}): Promise<BrowserScreenshot> {
    const shape = { ...(options.fullPage ? { fullPage: true } : {}), ...(options.ref !== undefined ? { ref: options.ref } : {}) }
    const result = await this.call('screenshot', [shape], options)
    if (!isPage(result) || !isRecord(result) || typeof result.data !== 'string'
      || (result.mediaType !== 'image/jpeg' && result.mediaType !== 'image/png')) throw malformed('screenshot')
    return { url: result.url, title: result.title, mediaType: result.mediaType, data: result.data }
  }

  console(query: BrowserLogQuery = {}): BrowserConsoleEntry[] {
    return queryConsole(this.consoleLog, query, this.logLimit)
  }

  network(query: BrowserLogQuery = {}): BrowserNetworkEntry[] {
    return queryNetwork(this.networkLog, query, this.logLimit)
  }

  async evaluate(expression: string, options?: BrowserCallOptions): Promise<unknown> {
    return await this.call('evaluate', [expression], options)
  }
}

/**
 * Provide `ctx.browser` from a daemon's browser. The composition layer mounts
 * it for a scope on a daemon that serves one; `@tnega/tool-browser` is the
 * same Consumer as on this machine.
 */
export const browserRemote = {
  name: 'browser-remote',
  async apply(ctx: Context, config: { link: DaemonLink }): Promise<void> {
    const browser = new RemoteBrowser(ctx, config.link)
    await browser.watch()
    ctx.fiber.effect(() => () => { void browser.unwatch() }, 'browser-remote/watch')
  },
}

export const name = '@tnega/browser-remote'
