/**
 * Vocabulary of the browser seam. Elements are addressed by the `ref` ids that
 * appear in the latest {@link BrowserSnapshot} (`[ref=e12]`); a ref is only
 * meaningful until the page changes, so callers re-snapshot after acting.
 */

export type BrowserAction =
  | { op: 'navigate'; url: string }
  | { op: 'back' }
  | { op: 'forward' }
  | { op: 'reload' }
  | { op: 'click'; ref: string; element?: string; button?: 'left' | 'right' | 'middle'; doubleClick?: boolean }
  | { op: 'hover'; ref: string; element?: string }
  /** Replaces the field's value; `submit` presses Enter afterwards. */
  | { op: 'type'; ref: string; element?: string; text: string; submit?: boolean }
  | { op: 'select'; ref: string; element?: string; values: string[] }
  /** A key or chord as Playwright names it, e.g. `Enter`, `Control+A`, `ArrowDown`. */
  | { op: 'press'; key: string }
  | { op: 'scroll'; deltaX?: number; deltaY: number }
  /** Waits for text to appear, to disappear, or for a fixed time. */
  | { op: 'wait'; text?: string; textGone?: string; ms?: number }
  | { op: 'resize'; width: number; height: number }

export type BrowserActionOp = BrowserAction['op']

/** Where the page is after an action or observation. */
export interface BrowserPageState {
  url: string
  title: string
}

export interface BrowserActionResult extends BrowserPageState {
  /** Short human-readable note, e.g. the HTTP status of a navigation. */
  note?: string
}

export interface BrowserSnapshot extends BrowserPageState {
  /** Accessibility tree as YAML-like text with `[ref=…]` element ids. */
  snapshot: string
  /** True when the snapshot was cut at the configured size limit. */
  truncated: boolean
}

export interface BrowserScreenshot extends BrowserPageState {
  mediaType: 'image/jpeg' | 'image/png'
  /** Base64 without a `data:` prefix. */
  data: string
}

export interface BrowserConsoleEntry {
  type: string
  text: string
  /** `url:line:column` of the call site when the browser reported one. */
  location?: string
  time: number
}

export interface BrowserNetworkEntry {
  method: string
  url: string
  resourceType: string
  status?: number
  /** Present when the request failed outright (DNS, refused, aborted). */
  failure?: string
  time: number
}

export interface BrowserLogQuery {
  /** Only entries recorded after this time (ms since epoch). */
  since?: number
  /** Most recent entries to return. */
  limit?: number
  /** Console: only `error` and `warning`; network: only failed or 4xx/5xx. */
  onlyProblems?: boolean
}

export interface BrowserCallOptions {
  signal?: AbortSignal
}

/** Payload of `browser/pre-action`; a handler may rewrite `action` or veto with `deny`. */
export interface BrowserPreActionEvent {
  action: BrowserAction
  /** Page the action will run against, before it runs. */
  page: BrowserPageState
  deny?: string
}

/** Payload of `browser/action`, emitted after every action settles. */
export interface BrowserActionEvent {
  action: BrowserAction
  page: BrowserPageState
  ok: boolean
  result?: BrowserActionResult
  error?: { code: BrowserErrorCode; message: string }
  startedAt: number
  durationMs: number
}

export type BrowserErrorCode =
  /** No browser could be started or attached. */
  | 'BROWSER_UNAVAILABLE'
  /** The ref is not in the current page; take a new snapshot. */
  | 'BROWSER_STALE_REF'
  /** A `browser/pre-action` handler refused the action. */
  | 'BROWSER_DENIED'
  /** The page did not settle in time. */
  | 'BROWSER_TIMEOUT'
  | 'BROWSER_ABORTED'
  | 'BROWSER_FAILED'

export class BrowserError extends Error {
  override name = 'BrowserError'
  constructor(readonly code: BrowserErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Snapshot text beyond this many characters is truncated. */
export const DEFAULT_BROWSER_SNAPSHOT_MAX_CHARS = 40_000
/** Per-action budget before `BROWSER_TIMEOUT`. */
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 15_000
/** Console and network entries kept per page. */
export const DEFAULT_BROWSER_LOG_LIMIT = 500

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

/**
 * Whether `url` points at a local development server: loopback addresses and
 * names under `.localhost` / `.test`, plus `file:`, `data:` and `about:blank`.
 */
export function isLocalUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'about:' || parsed.protocol === 'data:' || parsed.protocol === 'file:') return true
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return LOCAL_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.test')
}

/** Turn `localhost:5173` or `example.com` into a navigable URL. */
export function normalizeBrowserUrl(input: string): string {
  const value = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value) && !/^(?:localhost|[\d.]+):\d/iu.test(value)) return value
  const host = value.split(/[/:?#]/u)[0] ?? ''
  const local = LOCAL_HOSTS.has(host.toLowerCase()) || host.endsWith('.localhost') || /^[\d.]+$/u.test(host)
  return `${local ? 'http' : 'https'}://${value}`
}
