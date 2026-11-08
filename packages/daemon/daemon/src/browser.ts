import { RpcError, RpcErrorCode } from '@tnega/daemon-protocol'
import {
  parseBrowserAction,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserCallOptions,
  type BrowserConsoleEntry,
  type BrowserLogEvent,
  type BrowserLogQuery,
  type BrowserNetworkEntry,
  type BrowserPageState,
  type BrowserScreenshot,
  type BrowserSnapshot,
  type BrowserTab,
} from '@tnega/browser'
import type { ExposedService } from './services.js'

/**
 * What the daemon needs of a browser: the shape of `@tnega/browser-playwright`'s
 * `PlaywrightBrowserHost`, named here so the daemon does not load Playwright
 * unless the command that starts it does.
 */
export interface DaemonBrowser {
  state(): BrowserPageState
  tabs(): BrowserTab[]
  run(action: BrowserAction, options?: BrowserCallOptions): Promise<BrowserActionResult>
  snapshot(options?: BrowserCallOptions): Promise<BrowserSnapshot>
  screenshot(options?: BrowserCallOptions & { fullPage?: boolean; ref?: string }): Promise<BrowserScreenshot>
  evaluate(expression: string, options?: BrowserCallOptions): Promise<unknown>
  console(query?: BrowserLogQuery): BrowserConsoleEntry[]
  network(query?: BrowserLogQuery): BrowserNetworkEntry[]
  onLog(listener: (event: BrowserLogEvent) => void): () => void
  /** Page and tab changes, without frames: a runtime caches them. */
  readonly live: { subscribe(listener: (event: { type: string }) => void, options?: { frames?: boolean }): () => void }
}

/** What the `watch` stream sends: the page and tabs as they change, and every log entry. */
export type BrowserWatchEvent =
  | { type: 'state'; url: string; title: string }
  | { type: 'tabs'; tabs: BrowserTab[] }
  | BrowserLogEvent & { type: 'log' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new RpcError(message, RpcErrorCode.INVALID_PARAMS)
}

/** `browser/pre-action` already ran in the runtime that sent it; here only the shape is checked. */
function action(value: unknown): BrowserAction {
  return parseBrowserAction(value) ?? invalid('not a browser action')
}

function query(value: unknown): BrowserLogQuery {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) invalid('query must be an object')
  return {
    ...(typeof value.since === 'number' ? { since: value.since } : {}),
    ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
    ...(value.onlyProblems === true ? { onlyProblems: true } : {}),
  }
}

function shot(value: unknown): { fullPage?: boolean; ref?: string } {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) invalid('options must be an object')
  return {
    ...(value.fullPage === true ? { fullPage: true } : {}),
    ...(typeof value.ref === 'string' ? { ref: value.ref } : {}),
  }
}

/**
 * `ctx.browser` as the daemon serves it: the browser runs on this machine,
 * its own profile, and the runtime drives it. Policy (`browser/pre-action`)
 * runs in the runtime before an action is sent. Frames are not forwarded.
 */
export function exposeBrowser(browser: DaemonBrowser): ExposedService {
  return {
    calls: {
      state: () => browser.state(),
      tabs: () => browser.tabs(),
      run: ([value], { signal }) => browser.run(action(value), { signal }),
      snapshot: (_args, { signal }) => browser.snapshot({ signal }),
      screenshot: ([options], { signal }) => browser.screenshot({ ...shot(options), signal }),
      evaluate: ([expression], { signal }) => {
        if (typeof expression !== 'string') invalid('expression must be a string')
        return browser.evaluate(expression, { signal })
      },
      console: ([value]) => browser.console(query(value)),
      network: ([value]) => browser.network(query(value)),
    },
    streams: {
      watch: (_args, emit) => {
        emit({ type: 'state', ...browser.state() } satisfies BrowserWatchEvent)
        emit({ type: 'tabs', tabs: browser.tabs() } satisfies BrowserWatchEvent)
        const offLive = browser.live.subscribe(event => {
          if (event.type === 'state' || event.type === 'tabs') emit(event)
        }, { frames: false })
        const offLog = browser.onLog(event => emit({ type: 'log', ...event } satisfies BrowserWatchEvent))
        return () => { offLive(); offLog() }
      },
    },
  }
}
