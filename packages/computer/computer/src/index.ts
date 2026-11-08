import { Service, type Context } from '@tnega/core'
import {
  COMPUTER_MAX_STEPS,
  COMPUTER_STEP_OPS,
  ComputerError,
  type ComputerAction,
  type ComputerAim,
  type ComputerApp,
  type ComputerActionEvent,
  type ComputerActionResult,
  type ComputerCallOptions,
  type ComputerPoint,
  type ComputerPreActionEvent,
  type ComputerRegion,
  type ComputerScreenshot,
  type ComputerStep,
  type ComputerTree,
  type ComputerTreeOptions,
  type ComputerWindow,
} from './types.js'

export * from './types.js'

declare module '@tnega/core' {
  interface ServiceMap {
    computer: ComputerService
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorOf(error: unknown): { code: ComputerError['code']; message: string } {
  if (error instanceof ComputerError) return { code: error.code, message: error.message }
  return { code: 'COMPUTER_FAILED', message: error instanceof Error ? error.message : String(error) }
}

function isPreAction(value: unknown): value is ComputerPreActionEvent {
  return isRecord(value) && isRecord(value.action) && typeof value.action.op === 'string'
}

/** The window an action targets, if it targets one. */
export function actionWindowId(action: ComputerAction): number | undefined {
  return action.op === 'launch' || action.op === 'clipboard-read' || action.op === 'clipboard-write' ? undefined : action.windowId
}

function assertPoint(op: string, x: unknown, y: unknown): void {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError(`${op}: give both x and y`)
}

/**
 * Throws a `TypeError` when an action is malformed: a pointer action must aim
 * at exactly one of an element or a point, a menu needs a path, a batch needs
 * steps of its own window. Typed callers cannot get this wrong; tool input and
 * policy rewrites can.
 */
export function assertAction(action: ComputerAction): void {
  const op = action.op
  switch (action.op) {
    case 'type':
    case 'key':
      if (action.element !== undefined && (typeof action.element !== 'string' || !action.element)) {
        throw new TypeError(`${op}: element must be an element token`)
      }
      return
    case 'click':
    case 'scroll': {
      const element = action.element !== undefined
      const point = action.x !== undefined || action.y !== undefined
      if (element && point) throw new TypeError(`${op}: give an element or a point, not both`)
      if (element) {
        if (typeof action.element !== 'string' || !action.element) throw new TypeError(`${op}: element must be an element token`)
        return
      }
      if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) throw new TypeError(`${op}: give an element or both x and y`)
      return
    }
    case 'hover':
      assertPoint(op, action.x, action.y)
      return
    case 'menu':
      if (!Array.isArray(action.path) || !action.path.length || action.path.some(label => typeof label !== 'string' || !label.trim())) {
        throw new TypeError('menu: path must list the menu labels from the top, e.g. ["File", "Save As..."]')
      }
      return
    case 'clipboard-write':
      if (typeof action.text !== 'string') throw new TypeError('clipboard-write: text must be a string')
      return
    case 'steps': {
      const steps: unknown = action.steps
      if (!Array.isArray(steps) || !steps.length) throw new TypeError('steps: give at least one step')
      if (steps.length > COMPUTER_MAX_STEPS) throw new TypeError(`steps: at most ${COMPUTER_MAX_STEPS} steps`)
      for (const step of action.steps) {
        if (!COMPUTER_STEP_OPS.has(step.op)) throw new TypeError(`steps: ${step.op} cannot run inside a batch`)
        if (step.windowId !== action.windowId) throw new TypeError('steps: every step must act in the batch\'s window')
        assertAction(step)
      }
      return
    }
    case 'drag':
    case 'launch':
    case 'clipboard-read':
      return
  }
}

function parsePoint(value: unknown): ComputerPoint | undefined {
  if (!isRecord(value) || typeof value.x !== 'number' || typeof value.y !== 'number') return undefined
  return { x: value.x, y: value.y }
}

/** An element or a point; both, or neither, is not an aim. */
function parseAim(value: Record<string, unknown>): ComputerAim | undefined {
  const point = value.x !== undefined || value.y !== undefined
  if (typeof value.element === 'string') return point ? undefined : { element: value.element }
  if (typeof value.x === 'number' && typeof value.y === 'number') return { x: value.x, y: value.y }
  return undefined
}

function parseStep(value: Record<string, unknown>, windowId: number): ComputerStep | undefined {
  const element = typeof value.element === 'string' ? { element: value.element } : {}
  switch (value.op) {
    case 'click': {
      const aim = parseAim(value)
      if (!aim) return undefined
      const button: { button?: 'left' | 'right' | 'middle' } = {}
      if (value.button === 'left' || value.button === 'right' || value.button === 'middle') button.button = value.button
      const count = typeof value.count === 'number' ? { count: value.count } : {}
      return { op: 'click', windowId, ...button, ...count, ...aim }
    }
    case 'type':
      return typeof value.text === 'string' ? { op: 'type', windowId, text: value.text, ...element } : undefined
    case 'key': {
      const keys = value.keys
      if (!Array.isArray(keys) || !keys.length) return undefined
      const names = keys.filter((key): key is string => typeof key === 'string')
      return names.length === keys.length ? { op: 'key', windowId, keys: names, ...element } : undefined
    }
    case 'scroll': {
      const aim = parseAim(value)
      const direction = value.direction
      if (!aim || (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right')) return undefined
      return { op: 'scroll', windowId, direction, ...(typeof value.amount === 'number' ? { amount: value.amount } : {}), ...aim }
    }
    case 'drag': {
      const from = parsePoint(value.from)
      const to = parsePoint(value.to)
      return from && to ? { op: 'drag', windowId, from, to } : undefined
    }
    case 'hover': {
      const point = parsePoint(value)
      return point ? { op: 'hover', windowId, ...point } : undefined
    }
    default:
      return undefined
  }
}

/**
 * Read a `ComputerAction` that arrived as data (over a wire, from a file):
 * `undefined` when it is not one. Only the shape is checked here;
 * {@link assertAction} still judges what a typed action may not do.
 */
export function parseComputerAction(value: unknown): ComputerAction | undefined {
  if (!isRecord(value)) return undefined
  switch (value.op) {
    case 'launch': {
      if (typeof value.app !== 'string') return undefined
      const urls = value.urls
      if (urls !== undefined && (!Array.isArray(urls) || !urls.every(url => typeof url === 'string'))) return undefined
      return {
        op: 'launch',
        app: value.app,
        ...(typeof value.id === 'string' ? { id: value.id } : {}),
        ...(Array.isArray(urls) ? { urls: urls.filter((url): url is string => typeof url === 'string') } : {}),
      }
    }
    case 'clipboard-read': return { op: 'clipboard-read' }
    case 'clipboard-write': return typeof value.text === 'string' ? { op: 'clipboard-write', text: value.text } : undefined
  }
  const windowId = value.windowId
  if (typeof windowId !== 'number' || !Number.isInteger(windowId)) return undefined
  switch (value.op) {
    case 'menu': {
      const path = value.path
      if (!Array.isArray(path)) return undefined
      const labels = path.filter((label): label is string => typeof label === 'string')
      return labels.length === path.length ? { op: 'menu', windowId, path: labels } : undefined
    }
    case 'steps': {
      if (!Array.isArray(value.steps)) return undefined
      const steps: ComputerStep[] = []
      for (const step of value.steps) {
        if (!isRecord(step) || step.windowId !== windowId) return undefined
        const parsed = parseStep(step, windowId)
        if (!parsed) return undefined
        steps.push(parsed)
      }
      return { op: 'steps', windowId, steps }
    }
    default:
      return parseStep(value, windowId)
  }
}

/**
 * Service Definition of the computer seam: the agent sees and uses the apps
 * on this machine. Owns `ctx.computer` and the `computer/*` event surface; a
 * Service Provider supplies the mechanism (a driver process), and the
 * model-visible tools are a Consumer that only imports this package.
 *
 * Contract:
 *
 * - **Actions go through {@link ComputerService.act}.** It resolves the target
 *   window, dispatches `computer/pre-action` (waterfall: rewrite the action or
 *   set `deny`) and then `computer/action` for every outcome, so a Provider
 *   cannot bypass policy or auditing.
 * - **Looking is side-effect free.** `windows`, `apps`, `screenshot`, `zoom`
 *   and `tree` never send input.
 * - **A batch is judged step by step.** Every step of a `steps` action passes
 *   `computer/pre-action` before the first one runs, and each step that ran
 *   is reported on `computer/action`.
 * - **Aim at an element or a point, never both.** Element tokens come from the
 *   latest `tree` read of the window; points are window pixels of the latest
 *   screenshot of that window.
 * - **Fail closed.** With no working driver every call throws
 *   `COMPUTER_UNAVAILABLE`; nothing falls back to another input path.
 */
export abstract class ComputerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'computer')
  }

  /** Top-level windows the agent could work in, front-most first when known. */
  abstract windows(options?: ComputerCallOptions): Promise<ComputerWindow[]>

  /** A screenshot of one window. */
  abstract screenshot(windowId: number, options?: ComputerCallOptions): Promise<ComputerScreenshot>

  /** A sharper crop of a region of the window's latest screenshot. */
  abstract zoom(windowId: number, region: ComputerRegion, options?: ComputerCallOptions): Promise<ComputerScreenshot>

  /**
   * The window's accessibility tree, whose rows give element tokens for
   * actions. A Provider without one fails with `COMPUTER_UNAVAILABLE`, and the
   * caller falls back to screenshots and points.
   */
  async tree(windowId: number, options?: ComputerTreeOptions): Promise<ComputerTree> {
    if (options?.signal?.aborted) throw new ComputerError('COMPUTER_ABORTED', 'computer call was cancelled')
    throw new ComputerError('COMPUTER_UNAVAILABLE', `this computer cannot read the element tree of window ${windowId}; use screenshots and points`)
  }

  /**
   * Apps on this machine, running or installed, so the agent can start the
   * one it means. A Provider without a list fails with `COMPUTER_UNAVAILABLE`.
   */
  async apps(options?: ComputerCallOptions): Promise<ComputerApp[]> {
    if (options?.signal?.aborted) throw new ComputerError('COMPUTER_ABORTED', 'computer call was cancelled')
    throw new ComputerError('COMPUTER_UNAVAILABLE', 'this computer cannot list its apps; use computer_list_windows')
  }

  /** Perform one action. Only called by {@link ComputerService.act}. */
  protected abstract runAction(action: ComputerAction, options: ComputerCallOptions): Promise<ComputerActionResult>

  /** One open window by id, or `undefined` when it has closed. */
  async window(windowId: number, options?: ComputerCallOptions): Promise<ComputerWindow | undefined> {
    return (await this.windows(options)).find(window => window.id === windowId)
  }

  /**
   * Perform `action`.
   *
   * Events: `computer/pre-action` (may rewrite or deny) → Provider →
   * `computer/action` with the result or the failure.
   *
   * @throws ComputerError `COMPUTER_NO_WINDOW` when the target window is gone,
   *   `COMPUTER_DENIED` when policy refused; otherwise the Provider's failure.
   * @throws TypeError when the action is malformed (see {@link assertAction}).
   */
  async act(action: ComputerAction, options: ComputerCallOptions = {}): Promise<ComputerActionResult> {
    assertAction(action)
    const startedAt = Date.now()
    let active = action
    let window: ComputerWindow | undefined
    let result: ComputerActionResult
    const emit = async (event: Omit<ComputerActionEvent, 'startedAt' | 'durationMs'>): Promise<void> => {
      await this.ctx.parallel('computer/action', { ...event, startedAt, durationMs: Date.now() - startedAt })
    }
    const windowId = actionWindowId(action)
    try {
      if (windowId !== undefined) {
        window = await this.window(windowId, options)
        if (!window) throw new ComputerError('COMPUTER_NO_WINDOW', `window ${windowId} is not open; call computer_list_windows`)
      }
      if (action.op === 'steps') {
        // Every step is judged before the first runs, so a refusal changes nothing.
        const steps = []
        for (const step of action.steps) {
          if (options.signal?.aborted) throw new ComputerError('COMPUTER_ABORTED', 'computer action was cancelled')
          const judged = await this.judge(step, window, options.signal)
          if (!isStep(judged)) throw new ComputerError('COMPUTER_DENIED', `computer/pre-action turned a ${step.op} step into ${judged.op}, which cannot run inside a batch`)
          steps.push(judged)
        }
        active = { ...action, steps }
      } else {
        active = await this.judge(action, window, options.signal)
      }
      assertAction(active)
      if (options.signal?.aborted) throw new ComputerError('COMPUTER_ABORTED', 'computer action was cancelled')
      result = await this.runAction(active, options)
    } catch (error) {
      await emit({ action: active, ...(window ? { window } : {}), ok: false, error: errorOf(error) })
        .catch(audit => this.ctx.logger('computer').warn('computer/action listener failed', audit))
      throw error
    }
    // The action happened: a failing listener must not turn it into a failure.
    const events = active.op === 'steps'
      ? stepEvents(active.steps, result)
      : [{ action: active, ok: true, result }]
    for (const event of events) {
      await emit({ ...event, ...(window ? { window } : {}) }).catch(audit => this.ctx.logger('computer').warn('computer/action listener failed', audit))
    }
    return result
  }

  /** `computer/pre-action` for one action: the action to run, or a `COMPUTER_DENIED` throw. */
  private async judge(action: ComputerAction, window: ComputerWindow | undefined, signal: AbortSignal | undefined): Promise<ComputerAction> {
    const pre: ComputerPreActionEvent = { action, ...(window ? { window } : {}), ...(signal ? { signal } : {}) }
    const resolved: unknown = await this.ctx.waterfallAsync(
      'computer/pre-action',
      pre,
      async (payload: ComputerPreActionEvent) => payload,
    )
    if (!isPreAction(resolved)) throw new ComputerError('COMPUTER_DENIED', 'computer/pre-action did not forward the action')
    if (resolved.deny) throw new ComputerError('COMPUTER_DENIED', resolved.deny)
    // Policy judged this window; a rewrite may change how, not where.
    if (actionWindowId(resolved.action) !== actionWindowId(action)) {
      throw new ComputerError('COMPUTER_DENIED', 'computer/pre-action may not move the action to another window')
    }
    return resolved.action
  }
}

function isStep(action: ComputerAction): action is ComputerStep {
  return COMPUTER_STEP_OPS.has(action.op)
}

/** One `computer/action` per step that ran; steps after a failure never happened. */
function stepEvents(steps: ComputerStep[], result: ComputerActionResult): StepEvent[] {
  const events: StepEvent[] = []
  for (const [index, outcome] of (result.steps ?? []).entries()) {
    const step = steps[index]
    if (!step) break
    events.push(outcome.ok
      ? { action: step, ok: true, result: { note: outcome.note, ...(result.windowId !== undefined ? { windowId: result.windowId } : {}) } }
      : { action: step, ok: false, error: { code: 'COMPUTER_FAILED', message: outcome.note } })
  }
  return events
}

type StepEvent = Omit<ComputerActionEvent, 'startedAt' | 'durationMs' | 'window'>

export const name = '@tnega/computer'
