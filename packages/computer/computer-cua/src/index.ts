import type { Context } from '@tnega/core'
import {
  ComputerError,
  ComputerService,
  type ComputerAction,
  type ComputerActionResult,
  type ComputerCallOptions,
  type ComputerEffect,
  type ComputerRegion,
  type ComputerScreenshot,
  type ComputerTree,
  type ComputerTreeOptions,
  type ComputerWindow,
} from '@tnega/computer'
import { DRIVER_INSTALL_HINT, connectDriver, findDriver, type DriverConnection, type DriverConnector, type DriverResult } from './driver.js'

export { DRIVER_INSTALL_HINT, connectDriver, driverCandidates, findDriver, readResult, type DriverConnection, type DriverConnector, type DriverResult } from './driver.js'

export interface Config {
  /** Path to the `cua-driver` binary; else `TNEGA_CUA_DRIVER`, PATH, then the installer's folder. */
  driverPath?: string
  /**
   * Long edge of screenshots in pixels. Defaults to 1024: on a 3200×1904 window
   * that is 402 KiB and about 400 image tokens, still legible for abstract-size
   * text. 1568 (the driver's cap) costs 724 KiB and ~950 tokens for no
   * legibility the task needs; raise it when a task needs finer detail.
   */
  maxImageDimension?: number
  /** Replace how the driver is started, for tests. */
  connect?: DriverConnector
}

const DEFAULT_MAX_IMAGE_DIMENSION = 1024

const MODIFIERS = new Set(['ctrl', 'control', 'shift', 'alt', 'option', 'cmd', 'command', 'super', 'win', 'meta'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** One `list_windows` row, or `undefined` for the driver's own overlay windows. */
function toWindow(row: unknown): { window: ComputerWindow; z: number | undefined } | undefined {
  if (!isRecord(row) || typeof row.window_id !== 'number' || typeof row.pid !== 'number') return undefined
  const title = typeof row.title === 'string' ? row.title : ''
  if (title.startsWith('Cua.')) return undefined
  const bounds = isRecord(row.bounds) ? row.bounds : row
  return {
    window: {
      id: row.window_id,
      pid: row.pid,
      app: typeof row.app_name === 'string' ? row.app_name : '',
      title,
      bounds: { x: num(bounds.x), y: num(bounds.y), width: num(bounds.width), height: num(bounds.height) },
      onScreen: row.is_on_screen !== false,
    },
    z: typeof row.z_index === 'number' ? row.z_index : undefined,
  }
}

/**
 * Whether the driver refused the background attempt before sending anything,
 * because the target's input stack does not take this event kind in the
 * background. Nothing was delivered, so sending it again in front is safe.
 */
export function backgroundRefused(result: DriverResult): boolean {
  return result.isError && result.structured.code === 'background_unavailable'
}

/**
 * Whether the driver sent the event but could not confirm the effect, because
 * it cannot read the target's field back. It may well have landed: resending
 * is exactly how a doubled character or a double click happens, so the result
 * says so and the caller checks the screenshot instead.
 */
export function backgroundUnconfirmed(result: DriverResult): boolean {
  if (result.isError) return false
  const escalation = result.structured.escalation
  return isRecord(escalation) && escalation.target === 'foreground'
}

const EFFECTS: readonly ComputerEffect[] = ['confirmed', 'unverifiable', 'suspected_noop', 'partial']

function effectOf(result: DriverResult): ComputerEffect | undefined {
  const effect = result.structured.effect
  return EFFECTS.find(known => known === effect)
}

/** Whether the driver refused an element token because a newer read replaced its snapshot. */
export function staleElement(result: DriverResult): boolean {
  if (!result.isError) return false
  const refusal = isRecord(result.structured.refusal) ? result.structured.refusal : {}
  return result.structured.code === 'stale_element_token' || refusal.code === 'stale_element_token'
}

/** Whether an action addresses an element, which needs no prior screenshot. */
function aimsAtElement(action: ComputerAction): boolean {
  return 'element' in action && typeof action.element === 'string'
}

function failure(result: DriverResult, what: string): ComputerError {
  const code = typeof result.structured.code === 'string' ? ` (${result.structured.code})` : ''
  return new ComputerError('COMPUTER_FAILED', `${what} failed${code}: ${result.text || 'no detail from the driver'}`)
}

function aim(action: { element?: string | undefined; x?: number | undefined; y?: number | undefined }): Record<string, unknown> {
  return action.element ? { element_token: action.element } : { x: action.x, y: action.y }
}

/** The driver tool and arguments for one action, without the delivery mode. */
export function driverCall(action: ComputerAction, pid: number): { tool: string; args: Record<string, unknown> } {
  switch (action.op) {
    case 'click':
      return {
        tool: 'click',
        args: { pid, window_id: action.windowId, ...aim(action), ...(action.button ? { button: action.button } : {}), ...(action.count ? { count: action.count } : {}) },
      }
    case 'type':
      return { tool: 'type_text', args: { pid, window_id: action.windowId, ...(action.element ? { element_token: action.element } : {}), text: action.text } }
    case 'key': {
      const keys = action.keys.map(key => key.trim().toLowerCase()).filter(Boolean)
      const last = keys.at(-1)
      if (!last) throw new ComputerError('COMPUTER_FAILED', 'no key to press')
      const modifiers = keys.slice(0, -1)
      if (modifiers.some(key => !MODIFIERS.has(key))) throw new ComputerError('COMPUTER_FAILED', `only the last key of a chord may be a non-modifier: ${keys.join('+')}`)
      if (modifiers.length && action.element) throw new ComputerError('COMPUTER_FAILED', 'a chord goes to the focused window; click the element first, then press the chord without element_token')
      return modifiers.length
        ? { tool: 'hotkey', args: { pid, window_id: action.windowId, keys } }
        : { tool: 'press_key', args: { pid, window_id: action.windowId, ...(action.element ? { element_token: action.element } : {}), key: last } }
    }
    case 'scroll':
      return {
        tool: 'scroll',
        args: { pid, window_id: action.windowId, ...aim(action), direction: action.direction, ...(action.amount ? { amount: action.amount } : {}) },
      }
    case 'drag':
      return {
        tool: 'drag',
        args: { pid, window_id: action.windowId, from_x: action.from.x, from_y: action.from.y, to_x: action.to.x, to_y: action.to.y },
      }
    case 'launch': {
      const urls = action.urls ?? []
      // The driver hands `urls` to the system's default browser, whatever app
      // is being launched. Naming the executable instead lets the URLs reach
      // that app as its own arguments.
      if (!/[\\/]/.test(action.app)) {
        return { tool: 'launch_app', args: { name: action.app, ...(urls.length ? { urls } : {}) } }
      }
      return { tool: 'launch_app', args: { path: action.app, ...(urls.length ? { additional_arguments: urls } : {}) } }
    }
  }
}

/**
 * Service Provider of `ctx.computer`, backed by cua-driver over MCP. The
 * driver starts on first use and stops with the plugin. Input goes to the
 * window in the background first; a surface that only takes input in front
 * (Chromium on X11, for one) is retried with the window brought forward.
 */
export class CuaComputer extends ComputerService {
  private _connection: Promise<DriverConnection> | undefined
  /** Windows read in this connection; the driver refuses pixel input on a window it never captured. */
  private readonly _captured = new Set<number>()

  constructor(ctx: Context, private readonly _config: Config = {}) {
    super(ctx)
  }

  async close(): Promise<void> {
    const connection = this._connection
    this._connection = undefined
    this._captured.clear()
    if (connection) await connection.then(open => open.close(), () => undefined)
  }

  private connection(): Promise<DriverConnection> {
    this._connection ??= (async () => {
      const path = await findDriver(this._config.driverPath)
      if (!path) throw new ComputerError('COMPUTER_UNAVAILABLE', `cua-driver is not installed. ${DRIVER_INSTALL_HINT}`)
      try {
        return await (this._config.connect ?? connectDriver)(path)
      } catch (error) {
        throw new ComputerError('COMPUTER_UNAVAILABLE', `cua-driver did not start: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    const pending = this._connection
    // A failed start is not cached: installing the driver mid-session works on the next call.
    pending.catch(() => { if (this._connection === pending) this._connection = undefined })
    return pending
  }

  private async call(tool: string, args: Record<string, unknown>, options: ComputerCallOptions = {}): Promise<DriverResult> {
    if (options.signal?.aborted) throw new ComputerError('COMPUTER_ABORTED', 'computer call was cancelled')
    const connection = await this.connection()
    return connection.call(tool, args, options.signal)
  }

  async windows(options?: ComputerCallOptions): Promise<ComputerWindow[]> {
    const result = await this.call('list_windows', {}, options)
    if (result.isError) throw failure(result, 'listing windows')
    const rows = Array.isArray(result.structured.windows) ? result.structured.windows : []
    const windows = rows.map(toWindow).filter(row => row !== undefined)
    // Highest z_index is front-most; unknown stacking keeps the driver's order.
    windows.sort((a, b) => (b.z ?? -Infinity) - (a.z ?? -Infinity))
    return windows.map(row => row.window)
  }

  private async target(windowId: number, options?: ComputerCallOptions): Promise<ComputerWindow> {
    const window = await this.window(windowId, options)
    if (!window) throw new ComputerError('COMPUTER_NO_WINDOW', `window ${windowId} is not open; call computer_list_windows`)
    return window
  }

  async screenshot(windowId: number, options?: ComputerCallOptions): Promise<ComputerScreenshot> {
    const window = await this.target(windowId, options)
    return this.capture(window, options)
  }

  private async capture(window: ComputerWindow, options?: ComputerCallOptions): Promise<ComputerScreenshot> {
    const read = () => this.call('get_window_state', {
      pid: window.pid,
      window_id: window.id,
      include_accessibility_tree: false,
      max_image_dimension: this._config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
    }, options)
    let result = await read()
    // An iconic window has nothing to render; restoring it is the only way to see
    // or act in it, and every later pixel action would fail the same way.
    if (!result.image && /minimi[sz]ed/i.test(`${result.text} ${String(result.structured.screenshot_error ?? '')}`)) {
      await this.call('bring_to_front', { pid: window.pid, window_id: window.id }, options)
      result = await read()
    }
    if (result.isError || !result.image) throw failure(result, `capturing window ${window.id}`)
    this._captured.add(window.id)
    return {
      windowId: window.id,
      app: window.app,
      title: typeof result.structured.window_title === 'string' ? result.structured.window_title : window.title,
      width: num(result.structured.screenshot_width),
      height: num(result.structured.screenshot_height),
      mediaType: result.image.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      data: result.image.data,
    }
  }

  override async tree(windowId: number, options: ComputerTreeOptions = {}): Promise<ComputerTree> {
    const window = await this.target(windowId, options)
    const result = await this.call('get_window_state', {
      pid: window.pid,
      window_id: window.id,
      // Tree only: the screenshot is its own call, and a tree read is the cheap one.
      include_screenshot: false,
      ...(options.query ? { query: options.query } : {}),
      ...(options.since ? { since: options.since } : {}),
      ...(options.maxElements ? { max_elements: options.maxElements } : {}),
      ...(options.maxDepth ? { max_depth: options.maxDepth } : {}),
    }, options)
    const s = result.structured
    if (result.isError || typeof s.snapshot_id !== 'string') throw failure(result, `reading the element tree of window ${window.id}`)
    return {
      windowId: window.id,
      app: window.app,
      title: typeof s.window_title === 'string' ? s.window_title : window.title,
      snapshotId: s.snapshot_id,
      markdown: typeof s.tree_markdown === 'string' ? s.tree_markdown : result.text,
      total: num(s.total_element_count, num(s.element_count)),
      returned: num(s.returned_element_count, num(s.element_count)),
      truncated: s.truncated === true,
      ...(typeof s.since_status === 'string' ? { sinceStatus: s.since_status } : {}),
    }
  }

  async zoom(windowId: number, region: ComputerRegion, options?: ComputerCallOptions): Promise<ComputerScreenshot> {
    const window = await this.target(windowId, options)
    if (!this._captured.has(window.id)) await this.capture(window, options)
    const result = await this.call('zoom', { pid: window.pid, window_id: window.id, ...region }, options)
    if (result.isError || !result.image) throw failure(result, `zooming into window ${window.id}`)
    return {
      windowId: window.id,
      app: window.app,
      title: window.title,
      width: num(result.structured.width, num(result.structured.screenshot_width)),
      height: num(result.structured.height, num(result.structured.screenshot_height)),
      mediaType: result.image.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      data: result.image.data,
    }
  }

  protected async runAction(action: ComputerAction, options: ComputerCallOptions): Promise<ComputerActionResult> {
    if (action.op === 'launch') {
      const { tool, args } = driverCall(action, 0)
      const result = await this.call(tool, args, options)
      if (result.isError) throw failure(result, `launching ${action.app}`)
      const launched = launchedWindow(result.structured)
      return { note: result.text || `Launched ${action.app}`, ...(launched !== undefined ? { windowId: launched } : {}) }
    }
    const window = await this.target(action.windowId, options)
    // The driver refuses pixel input on a window it never captured; an element needs no picture.
    if (!aimsAtElement(action) && !this._captured.has(window.id)) await this.capture(window, options)
    const { tool, args } = driverCall(action, window.pid)
    let result = await this.call(tool, args, options)
    // Only a refusal means nothing was delivered. An unconfirmed result may
    // already have landed, and resending it is how one keystroke becomes two.
    if (backgroundRefused(result)) result = await this.call(tool, { ...args, delivery_mode: 'foreground' }, options)
    // Not retried with a fresh read: the window may have changed for a reason the caller must see.
    if (staleElement(result)) throw new ComputerError('COMPUTER_STALE_ELEMENT', `element ${String(args.element_token)} is from an older read of window ${window.id}; read the element tree again and use a new token`)
    if (result.isError) throw failure(result, `${action.op} in window ${window.id}`)
    const note = backgroundUnconfirmed(result)
      ? `${result.text}\n(The driver sent this in the background but could not confirm it took effect. Check the screenshot before repeating it.)`
      : result.text
    const effect = effectOf(result)
    return { note, windowId: window.id, ...(effect ? { effect } : {}) }
  }
}

/** The window a launch opened, when the driver names exactly one. */
export function launchedWindow(structured: Record<string, unknown>): number | undefined {
  const windows = Array.isArray(structured.windows) ? structured.windows : []
  const ids = windows.flatMap(item => typeof item === 'object' && item !== null && 'window_id' in item && typeof item.window_id === 'number' ? [item.window_id] : [])
  return ids.length === 1 ? ids[0] : undefined
}

export const name = '@tnega/computer-cua'

/** Mount: `await ctx.plugin(computerCua, { driverPath })`. The driver stops with the plugin. */
export const computerCua = {
  name: 'computer-cua',
  apply(ctx: Context, config: Config = {}) {
    const computer = new CuaComputer(ctx, config)
    ctx.fiber.effect(() => () => computer.close(), 'computer-cua/close')
  },
}
