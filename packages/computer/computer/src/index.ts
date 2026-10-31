import { Service, type Context } from '@tnega/core'
import {
  ComputerError,
  type ComputerAction,
  type ComputerActionEvent,
  type ComputerActionResult,
  type ComputerCallOptions,
  type ComputerPreActionEvent,
  type ComputerRegion,
  type ComputerScreenshot,
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
  return action.op === 'launch' ? undefined : action.windowId
}

/**
 * Throws a `TypeError` unless a pointer action aims at exactly one of an
 * element or a point. Typed callers cannot get this wrong; tool input and
 * policy rewrites can.
 */
export function assertAim(action: ComputerAction): void {
  const op = action.op
  if (action.op === 'type' || action.op === 'key') {
    if (action.element !== undefined && (typeof action.element !== 'string' || !action.element)) {
      throw new TypeError(`${op}: element must be an element token`)
    }
    return
  }
  if (action.op !== 'click' && action.op !== 'scroll') return
  const element = action.element !== undefined
  const point = action.x !== undefined || action.y !== undefined
  if (element && point) throw new TypeError(`${op}: give an element or a point, not both`)
  if (element) {
    if (typeof action.element !== 'string' || !action.element) throw new TypeError(`${op}: element must be an element token`)
    return
  }
  if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) throw new TypeError(`${op}: give an element or both x and y`)
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
 * - **Looking is side-effect free.** `windows`, `screenshot`, `zoom` and
 *   `tree` never send input.
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
   * @throws TypeError when a click or scroll aims at both an element and a point, or neither.
   */
  async act(action: ComputerAction, options: ComputerCallOptions = {}): Promise<ComputerActionResult> {
    assertAim(action)
    const startedAt = Date.now()
    let active = action
    let window: ComputerWindow | undefined
    let result: ComputerActionResult
    const settle = async (outcome: Pick<ComputerActionEvent, 'ok' | 'result' | 'error'>): Promise<void> => {
      const event: ComputerActionEvent = {
        action: active,
        ...(window ? { window } : {}),
        ...outcome,
        startedAt,
        durationMs: Date.now() - startedAt,
      }
      await this.ctx.parallel('computer/action', event)
    }
    const windowId = actionWindowId(action)
    try {
      if (windowId !== undefined) {
        window = await this.window(windowId, options)
        if (!window) throw new ComputerError('COMPUTER_NO_WINDOW', `window ${windowId} is not open; call computer_list_windows`)
      }
      const pre: ComputerPreActionEvent = { action, ...(window ? { window } : {}) }
      const resolved: unknown = await this.ctx.waterfallAsync(
        'computer/pre-action',
        pre,
        async (payload: ComputerPreActionEvent) => payload,
      )
      if (!isPreAction(resolved)) throw new ComputerError('COMPUTER_DENIED', 'computer/pre-action did not forward the action')
      if (resolved.deny) throw new ComputerError('COMPUTER_DENIED', resolved.deny)
      // Policy judged this window; a rewrite may change how, not where.
      if (actionWindowId(resolved.action) !== windowId) {
        throw new ComputerError('COMPUTER_DENIED', 'computer/pre-action may not move the action to another window')
      }
      assertAim(resolved.action)
      active = resolved.action
      if (options.signal?.aborted) throw new ComputerError('COMPUTER_ABORTED', 'computer action was cancelled')
      result = await this.runAction(active, options)
    } catch (error) {
      await settle({ ok: false, error: errorOf(error) }).catch(audit => this.ctx.logger('computer').warn('computer/action listener failed', audit))
      throw error
    }
    // The action happened: a failing listener must not turn it into a failure.
    await settle({ ok: true, result }).catch(audit => this.ctx.logger('computer').warn('computer/action listener failed', audit))
    return result
  }
}

export const name = '@tnega/computer'
