import type { Context } from '@tnega/core'
import {
  ComputerError,
  ComputerService,
  type ComputerAction,
  type ComputerActionResult,
  type ComputerApp,
  type ComputerCallOptions,
  type ComputerEffect,
  type ComputerRegion,
  type ComputerScreenshot,
  type ComputerStep,
  type ComputerStepResult,
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

/** Whether the driver needs a screenshot of the window first: it refuses pixel input on a window it never captured. */
function needsCapture(action: ComputerAction): boolean {
  if (action.op === 'steps') return action.steps.some(needsCapture)
  if (action.op === 'menu' || action.op === 'launch' || action.op === 'clipboard-read' || action.op === 'clipboard-write') return false
  return !aimsAtElement(action)
}

function hovers(action: ComputerAction): boolean {
  return action.op === 'hover' || (action.op === 'steps' && action.steps.some(step => step.op === 'hover'))
}

/** Where a window is on the desktop, and the size of its latest screenshot, to place the real pointer. */
export interface HoverFrame {
  bounds: ComputerWindow['bounds']
  width: number
  height: number
}

/** A point of the window's latest screenshot in desktop coordinates, which is where the real pointer goes. */
export function desktopPoint(frame: HoverFrame, x: number, y: number): { x: number; y: number } {
  const sx = frame.width > 0 ? frame.bounds.width / frame.width : 1
  const sy = frame.height > 0 ? frame.bounds.height / frame.height : 1
  return { x: Math.round(frame.bounds.x + x * sx), y: Math.round(frame.bounds.y + y * sy) }
}

function failure(result: DriverResult, what: string): ComputerError {
  const code = typeof result.structured.code === 'string' ? ` (${result.structured.code})` : ''
  return new ComputerError('COMPUTER_FAILED', `${what} failed${code}: ${result.text || 'no detail from the driver'}`)
}

function aim(action: { element?: string | undefined; x?: number | undefined; y?: number | undefined }): Record<string, unknown> {
  return action.element ? { element_token: action.element } : { x: action.x, y: action.y }
}

/**
 * The driver tool and arguments for one step, without the delivery mode. A
 * hover needs `frame`: the driver only hovers with the real pointer, in
 * desktop coordinates.
 */
export function driverCall(action: ComputerStep | Extract<ComputerAction, { op: 'menu' | 'launch' }>, pid: number, frame?: HoverFrame): { tool: string; args: Record<string, unknown> } {
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
    case 'hover': {
      if (!frame || frame.width <= 0 || frame.height <= 0) throw new ComputerError('COMPUTER_FAILED', `take a screenshot of window ${action.windowId} before hovering in it`)
      // The real pointer outside the screenshot would hover another app's window, which this grant does not cover.
      if (action.x < 0 || action.y < 0 || action.x >= frame.width || action.y >= frame.height) {
        throw new ComputerError('COMPUTER_FAILED', `hover point (${action.x}, ${action.y}) is outside the ${frame.width}x${frame.height} screenshot of window ${action.windowId}`)
      }
      // Window scope only moves the driver's overlay cursor, which apps never see.
      return { tool: 'move_cursor', args: { target: { kind: 'desktop', display_id: 'primary' }, ...desktopPoint(frame, action.x, action.y) } }
    }
    case 'menu':
      return { tool: 'invoke_menu', args: { pid, window_id: action.windowId, path: action.path } }
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
  /** Windows read in this connection, with their latest screenshot size; the driver refuses pixel input on a window it never captured. */
  private readonly _captured = new Map<number, { width: number; height: number }>()
  /** How to start each app of the latest `apps()` read, by its id. */
  private readonly _apps = new Map<string, { bundleId?: string; launchPath?: string }>()

  constructor(ctx: Context, private readonly _config: Config = {}) {
    super(ctx)
  }

  async close(): Promise<void> {
    const connection = this._connection
    this._connection = undefined
    this._captured.clear()
    this._apps.clear()
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
    const width = num(result.structured.screenshot_width)
    const height = num(result.structured.screenshot_height)
    this._captured.set(window.id, { width, height })
    return {
      windowId: window.id,
      app: window.app,
      title: typeof result.structured.window_title === 'string' ? result.structured.window_title : window.title,
      width,
      height,
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

  override async apps(options?: ComputerCallOptions): Promise<ComputerApp[]> {
    const result = await this.call('list_apps', {}, options)
    if (result.isError) throw failure(result, 'listing apps')
    const rows = Array.isArray(result.structured.apps) ? result.structured.apps : []
    this._apps.clear()
    const apps: ComputerApp[] = []
    for (const row of rows) {
      const app = toApp(row)
      if (!app) continue
      apps.push(app.app)
      if (app.app.id) this._apps.set(app.app.id, app.launch)
    }
    return apps
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
    switch (action.op) {
      case 'launch':
        return this.launch(action, options)
      case 'clipboard-read': {
        const result = await this.call('clipboard_read', { include_text: true }, options)
        if (result.isError) throw failure(result, 'reading the clipboard')
        const text = typeof result.structured.text === 'string' ? result.structured.text : undefined
        return { note: text === undefined ? 'The clipboard holds no text.' : `The clipboard holds ${text.length} characters of text.`, ...(text !== undefined ? { text } : {}) }
      }
      case 'clipboard-write': {
        const result = await this.call('clipboard_write', { text: action.text }, options)
        if (result.isError) throw failure(result, 'writing the clipboard')
        return { note: `Put ${action.text.length} characters on the clipboard; paste with ctrl+v (cmd+v on a Mac).` }
      }
      default:
        break
    }
    const window = await this.target(action.windowId, options)
    if (needsCapture(action) && !this._captured.has(window.id)) await this.capture(window, options)
    // The real pointer hovers whatever is on top, so the window comes forward first.
    if (hovers(action)) {
      const front = await this.call('bring_to_front', { pid: window.pid, window_id: window.id }, options)
      if (front.isError) throw failure(front, `bringing window ${window.id} to the front to hover`)
    }
    const shot = this._captured.get(window.id)
    const frame = shot ? { bounds: window.bounds, ...shot } : undefined
    if (action.op === 'steps') return this.steps(action.steps, window, frame, options)
    const { tool, args } = driverCall(action, window.pid, frame)
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

  private async launch(action: Extract<ComputerAction, { op: 'launch' }>, options: ComputerCallOptions): Promise<ComputerActionResult> {
    const { tool, args } = driverCall(action, 0)
    const known = action.id ? this._apps.get(action.id) : undefined
    const result = await this.call(tool, {
      ...args,
      ...(known?.bundleId ? { bundle_id: known.bundleId } : {}),
      ...(known?.launchPath ? { launch_path: known.launchPath } : {}),
      // An id from an older list: the driver may still know it.
      ...(action.id && !known ? { bundle_id: action.id } : {}),
    }, options)
    if (result.isError) throw failure(result, `launching ${action.app}`)
    const launched = launchedWindow(result.structured)
    return { note: result.text || `Launched ${action.app}`, ...(launched !== undefined ? { windowId: launched } : {}) }
  }

  /**
   * One `run_steps` call. The driver checks every step before the first runs
   * and stops at the first failure; a step its target refuses in the
   * background is retried once in front by the driver itself, never the whole
   * batch, since earlier steps already happened.
   */
  private async steps(steps: ComputerStep[], window: ComputerWindow, frame: HoverFrame | undefined, options: ComputerCallOptions): Promise<ComputerActionResult> {
    const calls = steps.map(step => driverCall(step, window.pid, frame))
    const result = await this.call('run_steps', { pid: window.pid, window_id: window.id, foreground_fallback: true, steps: calls }, options)
    const rows = Array.isArray(result.structured.steps) ? result.structured.steps : []
    if (result.isError && !rows.length) throw failure(result, `steps in window ${window.id}`)
    const outcomes: ComputerStepResult[] = rows.flatMap(row => isRecord(row)
      ? [{ ok: row.ok === true, note: typeof row.message === 'string' ? row.message : row.ok === true ? 'ok' : 'failed' }]
      : [])
    const ran = outcomes.filter(step => step.ok).length
    const failed = outcomes.find(step => !step.ok)
    const lead = failed
      ? `Step ${outcomes.length} of ${steps.length} failed; ${ran} ran before it and the rest did not run.`
      : `Ran ${ran} of ${steps.length} steps.`
    const lines = outcomes.map((step, index) => `${index + 1}. ${steps[index]?.op ?? 'step'} ${step.ok ? 'ok' : 'FAILED'}: ${step.note}`)
    return { note: [lead, ...lines].join('\n'), windowId: window.id, steps: outcomes }
  }
}

/** One `list_apps` row that the agent could start or switch to; plain background processes are left out. */
function toApp(row: unknown): { app: ComputerApp; launch: { bundleId?: string; launchPath?: string } } | undefined {
  if (!isRecord(row) || typeof row.name !== 'string' || !row.name) return undefined
  const bundleId = typeof row.bundle_id === 'string' && row.bundle_id ? row.bundle_id : undefined
  const launchPath = typeof row.launch_path === 'string' && row.launch_path ? row.launch_path : undefined
  const windows = Array.isArray(row.windows) ? row.windows : []
  const windowIds = windows.flatMap(item => isRecord(item) && typeof item.window_id === 'number' && !String(item.title ?? '').startsWith('Cua.') ? [item.window_id] : [])
  if (!bundleId && !launchPath && !windowIds.length) return undefined
  const id = bundleId ?? launchPath
  const running = row.running === true
  return {
    app: { name: row.name, ...(id ? { id } : {}), running, ...(running && typeof row.pid === 'number' && row.pid > 0 ? { pid: row.pid } : {}), windowIds },
    launch: { ...(bundleId ? { bundleId } : {}), ...(launchPath ? { launchPath } : {}) },
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
