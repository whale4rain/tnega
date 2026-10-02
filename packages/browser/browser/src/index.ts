import { Service, type Context } from '@tnega/core'
import {
  BrowserError,
  type BrowserAction,
  type BrowserActionEvent,
  type BrowserActionResult,
  type BrowserCallOptions,
  type BrowserConsoleEntry,
  type BrowserLogQuery,
  type BrowserNetworkEntry,
  type BrowserPageState,
  type BrowserPreActionEvent,
  type BrowserScreenshot,
  type BrowserSnapshot,
  type BrowserTab,
} from './types.js'

export * from './types.js'

declare module '@tnega/core' {
  interface Context {
    browser: BrowserService
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorOf(error: unknown): { code: BrowserError['code']; message: string } {
  if (error instanceof BrowserError) return { code: error.code, message: error.message }
  return { code: 'BROWSER_FAILED', message: error instanceof Error ? error.message : String(error) }
}

/**
 * Service Definition of the browser seam: one page the agent can drive. Owns
 * `ctx.browser` and the `browser/*` event surface; a Service Provider supplies
 * the mechanism (a launched browser, an embedded view), and the model-visible
 * tools are a Consumer that only imports this package.
 *
 * Contract:
 *
 * - **Actions go through {@link BrowserService.act}.** It dispatches
 *   `browser/pre-action` (waterfall: rewrite the action, set `deny` to refuse
 *   it) and then `browser/action` (parallel notification) for every outcome, so
 *   a Provider cannot bypass policy or auditing.
 * - **Observation is side-effect free.** `snapshot`, `screenshot`, `console`
 *   and `network` never change the page.
 * - **Refs come from the latest snapshot.** A ref the page no longer has fails
 *   with `BROWSER_STALE_REF`, never with a click somewhere else.
 * - **One Provider per scope**, and disposing it must not close a browser the
 *   Provider did not start (the embedded desktop view outlives runs).
 */
export abstract class BrowserService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'browser')
  }

  /** Current page without touching it. */
  abstract page(): BrowserPageState

  /** Open tabs, in order; exactly one is active once the browser has started. */
  abstract tabs(): BrowserTab[]

  /** Perform one action. Only called by {@link BrowserService.act}. */
  protected abstract runAction(action: BrowserAction, options: BrowserCallOptions): Promise<BrowserActionResult>

  abstract snapshot(options?: BrowserCallOptions): Promise<BrowserSnapshot>

  /** `fullPage` captures beyond the viewport; `ref` captures one element. */
  abstract screenshot(options?: BrowserCallOptions & { fullPage?: boolean; ref?: string }): Promise<BrowserScreenshot>

  abstract console(query?: BrowserLogQuery): BrowserConsoleEntry[]

  abstract network(query?: BrowserLogQuery): BrowserNetworkEntry[]

  /** Evaluate a JavaScript expression or function body in the page and return its JSON value. */
  abstract evaluate(expression: string, options?: BrowserCallOptions): Promise<unknown>

  /**
   * Perform `action` on the page.
   *
   * Events: `browser/pre-action` (may rewrite or deny) → Provider →
   * `browser/action` with the result or the failure.
   *
   * @throws BrowserError `BROWSER_DENIED` when policy refused; otherwise the Provider's failure.
   */
  async act(action: BrowserAction, options: BrowserCallOptions = {}): Promise<BrowserActionResult> {
    const startedAt = Date.now()
    let active = action
    const settle = async (outcome: Pick<BrowserActionEvent, 'ok' | 'result' | 'error'>): Promise<void> => {
      const event: BrowserActionEvent = {
        action: active,
        page: this.page(),
        ...outcome,
        startedAt,
        durationMs: Date.now() - startedAt,
      }
      await this.ctx.parallel('browser/action', event)
    }
    try {
      const pre: BrowserPreActionEvent = { action, page: this.page() }
      const resolved: unknown = await this.ctx.waterfallAsync(
        'browser/pre-action',
        pre,
        async (payload: BrowserPreActionEvent) => payload,
      )
      if (!isRecord(resolved) || !isRecord(resolved.action) || typeof resolved.action.op !== 'string') {
        throw new BrowserError('BROWSER_DENIED', 'browser/pre-action did not forward the action')
      }
      const event = resolved as unknown as BrowserPreActionEvent
      if (event.deny) throw new BrowserError('BROWSER_DENIED', event.deny)
      active = event.action
      if (options.signal?.aborted) throw new BrowserError('BROWSER_ABORTED', 'browser action was cancelled')
      const result = await this.runAction(active, options)
      await settle({ ok: true, result })
      return result
    } catch (error) {
      await settle({ ok: false, error: errorOf(error) })
      throw error
    }
  }
}

export const name = '@tnega/browser'
