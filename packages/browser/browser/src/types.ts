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
  /** Open a tab (optionally at a URL) and make it active. */
  | { op: 'tab_new'; url?: string }
  | { op: 'tab_select'; id: string }
  /** Close a tab, the active one by default; the last tab is replaced by a blank one. */
  | { op: 'tab_close'; id?: string }

export type BrowserActionOp = BrowserAction['op']

/** Where the page is after an action or observation. */
export interface BrowserPageState {
  url: string
  title: string
}

/** One open tab. Actions and observations apply to the active tab. */
export interface BrowserTab extends BrowserPageState {
  id: string
  active: boolean
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

/** One console or network entry as the browser records it. */
export type BrowserLogEvent =
  | { kind: 'console'; entry: BrowserConsoleEntry }
  | { kind: 'network'; entry: BrowserNetworkEntry }

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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read an action that crossed a wire (a daemon gets it from the runtime): the
 * action when every field it needs has the right type, else `undefined`.
 */
export function parseBrowserAction(value: unknown): BrowserAction | undefined {
  if (!isObject(value)) return undefined
  const text = (key: string): string | undefined => typeof value[key] === 'string' ? value[key] : undefined
  const num = (key: string): number | undefined => typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : undefined
  const element = text('element')
  const named = element === undefined ? {} : { element }
  const ref = text('ref')
  switch (value.op) {
    case 'navigate': { const url = text('url'); return url === undefined ? undefined : { op: 'navigate', url } }
    case 'back': return { op: 'back' }
    case 'forward': return { op: 'forward' }
    case 'reload': return { op: 'reload' }
    case 'click': {
      if (ref === undefined) return undefined
      const button = value.button === 'left' || value.button === 'right' || value.button === 'middle' ? value.button : undefined
      return { op: 'click', ref, ...named, ...(button ? { button } : {}), ...(value.doubleClick === true ? { doubleClick: true } : {}) }
    }
    case 'hover': return ref === undefined ? undefined : { op: 'hover', ref, ...named }
    case 'type': {
      const typed = text('text')
      if (ref === undefined || typed === undefined) return undefined
      return { op: 'type', ref, ...named, text: typed, ...(value.submit === true ? { submit: true } : {}) }
    }
    case 'select': {
      const values = value.values
      if (ref === undefined || !Array.isArray(values) || !values.every(item => typeof item === 'string')) return undefined
      return { op: 'select', ref, ...named, values: values.filter((item): item is string => typeof item === 'string') }
    }
    case 'press': { const key = text('key'); return key === undefined ? undefined : { op: 'press', key } }
    case 'scroll': {
      const deltaY = num('deltaY')
      const deltaX = num('deltaX')
      return deltaY === undefined ? undefined : { op: 'scroll', deltaY, ...(deltaX !== undefined ? { deltaX } : {}) }
    }
    case 'wait': {
      const waitText = text('text')
      const textGone = text('textGone')
      const ms = num('ms')
      return { op: 'wait', ...(waitText !== undefined ? { text: waitText } : {}), ...(textGone !== undefined ? { textGone } : {}), ...(ms !== undefined ? { ms } : {}) }
    }
    case 'resize': {
      const width = num('width')
      const height = num('height')
      return width === undefined || height === undefined ? undefined : { op: 'resize', width, height }
    }
    case 'tab_new': { const url = text('url'); return { op: 'tab_new', ...(url !== undefined ? { url } : {}) } }
    case 'tab_select': { const id = text('id'); return id === undefined ? undefined : { op: 'tab_select', id } }
    case 'tab_close': { const id = text('id'); return { op: 'tab_close', ...(id !== undefined ? { id } : {}) } }
    default: return undefined
  }
}

/** The console entries a query asks for, newest last. Shared by every Provider so they answer alike. */
export function queryConsole(entries: readonly BrowserConsoleEntry[], query: BrowserLogQuery, limit: number): BrowserConsoleEntry[] {
  const matching = entries.filter(entry => (query.since === undefined || entry.time > query.since)
    && (!query.onlyProblems || entry.type === 'error' || entry.type === 'warning'))
  return matching.slice(-(query.limit ?? limit))
}

/** The network entries a query asks for, newest last. */
export function queryNetwork(entries: readonly BrowserNetworkEntry[], query: BrowserLogQuery, limit: number): BrowserNetworkEntry[] {
  const matching = entries.filter(entry => (query.since === undefined || entry.time > query.since)
    && (!query.onlyProblems || entry.failure !== undefined || (entry.status ?? 0) >= 400))
  return matching.slice(-(query.limit ?? limit))
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
