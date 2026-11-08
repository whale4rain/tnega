import type { Context } from '@tnega/core'
import {
  ComputerError,
  ComputerService,
  type ComputerAction,
  type ComputerActionResult,
  type ComputerApp,
  type ComputerCallOptions,
  type ComputerChange,
  type ComputerEffect,
  type ComputerErrorCode,
  type ComputerRegion,
  type ComputerScreenshot,
  type ComputerStepResult,
  type ComputerTree,
  type ComputerTreeOptions,
  type ComputerWindow,
} from '@tnega/computer'
import { RemoteError, forwardService, type DaemonLink, type ServiceForwarder } from '@tnega/daemon-protocol'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const str = (value: unknown): value is string => typeof value === 'string'

function isWindow(value: unknown): value is ComputerWindow {
  if (!isRecord(value) || !num(value.id) || !num(value.pid) || !str(value.app) || !str(value.title) || typeof value.onScreen !== 'boolean') return false
  const bounds = value.bounds
  return isRecord(bounds) && num(bounds.x) && num(bounds.y) && num(bounds.width) && num(bounds.height)
}

function isApp(value: unknown): value is ComputerApp {
  return isRecord(value) && str(value.name) && typeof value.running === 'boolean'
    && Array.isArray(value.windowIds) && value.windowIds.every(num)
    && (value.id === undefined || str(value.id)) && (value.pid === undefined || num(value.pid))
}

function isScreenshot(value: unknown): value is ComputerScreenshot {
  return isRecord(value) && num(value.windowId) && str(value.app) && str(value.title) && num(value.width) && num(value.height)
    && (value.mediaType === 'image/png' || value.mediaType === 'image/jpeg') && str(value.data)
}

const EFFECTS: readonly ComputerEffect[] = ['confirmed', 'unverifiable', 'suspected_noop', 'partial']

function effectOf(value: unknown): ComputerEffect | undefined {
  return EFFECTS.find(effect => effect === value)
}

function changeOf(value: unknown): ComputerChange | undefined {
  if (!isRecord(value) || !str(value.status) || !num(value.added) || !num(value.changed) || !num(value.removed)) return undefined
  return { status: value.status, added: value.added, changed: value.changed, removed: value.removed, ...(str(value.diff) ? { diff: value.diff } : {}) }
}

function stepsOf(value: unknown): ComputerStepResult[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap(step => isRecord(step) && typeof step.ok === 'boolean' && str(step.note) ? [{ ok: step.ok, note: step.note }] : [])
}

function malformed(what: string): ComputerError {
  return new ComputerError('COMPUTER_FAILED', `the daemon sent a malformed ${what}`)
}

/** An action result with only the fields this side knows, each of the right type. */
function actionResult(value: unknown): ComputerActionResult {
  if (!isRecord(value) || !str(value.note)) throw malformed('action result')
  const effect = effectOf(value.effect)
  const change = changeOf(value.change)
  const steps = stepsOf(value.steps)
  const route = value.route === 'accessibility' || value.route === 'synthetic_events' ? value.route : undefined
  return {
    note: value.note,
    ...(num(value.windowId) ? { windowId: value.windowId } : {}),
    ...(effect ? { effect } : {}),
    ...(route ? { route } : {}),
    ...(change ? { change } : {}),
    ...(str(value.text) ? { text: value.text } : {}),
    ...(steps ? { steps } : {}),
  }
}

function tree(value: unknown): ComputerTree {
  if (!isRecord(value) || !num(value.windowId) || !str(value.app) || !str(value.title) || !str(value.snapshotId)
    || !str(value.markdown) || !num(value.total) || !num(value.returned) || typeof value.truncated !== 'boolean') throw malformed('element tree')
  const truncation = isRecord(value.truncation)
    ? { ...(str(value.truncation.reason) ? { reason: value.truncation.reason } : {}), ...(str(value.truncation.hint) ? { hint: value.truncation.hint } : {}) }
    : undefined
  return {
    windowId: value.windowId,
    app: value.app,
    title: value.title,
    snapshotId: value.snapshotId,
    markdown: value.markdown,
    total: value.total,
    returned: value.returned,
    truncated: value.truncated,
    ...(typeof value.complete === 'boolean' ? { complete: value.complete } : {}),
    ...(truncation ? { truncation } : {}),
    ...(str(value.sinceStatus) ? { sinceStatus: value.sinceStatus } : {}),
  }
}

const CODES: ReadonlySet<string> = new Set<ComputerErrorCode>([
  'COMPUTER_UNAVAILABLE', 'COMPUTER_DENIED', 'COMPUTER_NO_WINDOW', 'COMPUTER_ABORTED', 'COMPUTER_STALE_ELEMENT', 'COMPUTER_FAILED',
])

function isCode(value: unknown): value is ComputerErrorCode {
  return typeof value === 'string' && CODES.has(value)
}

/** A `ComputerError` from the daemon comes back as one, with its code, so the tools tell the model the same thing. */
function local(error: unknown): unknown {
  if (error instanceof RemoteError) {
    if (error.name === 'ComputerError' && isCode(error.code)) return new ComputerError(error.code, error.message)
    if (error.name === 'AbortError') return new ComputerError('COMPUTER_ABORTED', error.message)
    return new ComputerError('COMPUTER_FAILED', `the daemon's computer failed: ${error.message}`)
  }
  return error
}

/**
 * `ctx.computer` on a daemon. Looking and acting are forwarded calls; the
 * base class still runs `computer/pre-action` here first, so app tiers and
 * approvals stay with the runtime and the daemon only gets allowed actions.
 */
export class RemoteComputer extends ComputerService {
  private readonly remote: ServiceForwarder

  constructor(ctx: Context, link: DaemonLink) {
    super(ctx)
    if (!link.capabilities.services?.includes('computer')) {
      throw new ComputerError('COMPUTER_UNAVAILABLE', `daemon ${link.deviceId} does not offer computer use; the person there starts it with --computer`)
    }
    this.remote = forwardService(link, 'computer')
  }

  private async call(method: string, args: unknown[], options: ComputerCallOptions = {}): Promise<unknown> {
    try {
      return await this.remote.call(method, args, options.signal ? { signal: options.signal } : {})
    } catch (error) {
      throw local(error)
    }
  }

  async windows(options?: ComputerCallOptions): Promise<ComputerWindow[]> {
    const result = await this.call('windows', [], options)
    if (!Array.isArray(result) || !result.every(isWindow)) throw malformed('window list')
    return result
  }

  override async apps(options?: ComputerCallOptions): Promise<ComputerApp[]> {
    const result = await this.call('apps', [], options)
    if (!Array.isArray(result) || !result.every(isApp)) throw malformed('app list')
    return result
  }

  async screenshot(windowId: number, options?: ComputerCallOptions): Promise<ComputerScreenshot> {
    const result = await this.call('screenshot', [windowId], options)
    if (!isScreenshot(result)) throw malformed('screenshot')
    return result
  }

  async zoom(windowId: number, region: ComputerRegion, options?: ComputerCallOptions): Promise<ComputerScreenshot> {
    const result = await this.call('zoom', [windowId, region], options)
    if (!isScreenshot(result)) throw malformed('screenshot')
    return result
  }

  override async tree(windowId: number, options: ComputerTreeOptions = {}): Promise<ComputerTree> {
    const { signal, ...rest } = options
    return tree(await this.call('tree', [windowId, rest], signal ? { signal } : {}))
  }

  protected async runAction(action: ComputerAction, options: ComputerCallOptions): Promise<ComputerActionResult> {
    return actionResult(await this.call('act', [action], options))
  }
}

/**
 * Provide `ctx.computer` from a daemon that offers computer use. The
 * composition layer mounts it, then the same tiers and tools as on this
 * machine; it never falls back to this machine's apps.
 */
export const computerRemote = {
  name: 'computer-remote',
  apply(ctx: Context, config: { link: DaemonLink }): void {
    new RemoteComputer(ctx, config.link)
  },
}

export const name = '@tnega/computer-remote'
