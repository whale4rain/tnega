import { RpcError, RpcErrorCode } from '@tnega/daemon-protocol'
import {
  ComputerError,
  assertAction,
  parseComputerAction,
  type ComputerAction,
  type ComputerRegion,
  type ComputerService,
  type ComputerTreeOptions,
} from '@tnega/computer'
import type { ExposedService } from './services.js'

/**
 * What the daemon needs of computer use: this machine's `ctx.computer`, as a
 * Provider such as `@tnega/computer-cua` gives it. `act` runs this machine's
 * own `computer/pre-action`; the runtime's policy already ran before sending.
 */
export type DaemonComputer = Pick<ComputerService, 'windows' | 'screenshot' | 'zoom' | 'tree' | 'apps' | 'act'>

/** The person at this machine stays in charge of it. */
export interface DaemonComputerGuard {
  /** Why computer use is paused here, or `undefined` while it is on. Checked before every call. */
  paused(): string | undefined
  /** Told before an action runs, for an indicator the person here can see. */
  onAction?(action: ComputerAction): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new RpcError(message, RpcErrorCode.INVALID_PARAMS)
}

function windowId(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : invalid('windowId must be an integer')
}

function region(value: unknown): ComputerRegion {
  if (!isRecord(value)) invalid('region must be an object')
  const { x1, y1, x2, y2 } = value
  if (typeof x1 !== 'number' || typeof y1 !== 'number' || typeof x2 !== 'number' || typeof y2 !== 'number') invalid('region needs x1, y1, x2 and y2')
  return { x1, y1, x2, y2 }
}

function treeOptions(value: unknown): Omit<ComputerTreeOptions, 'signal'> {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) invalid('options must be an object')
  return {
    ...(typeof value.query === 'string' ? { query: value.query } : {}),
    ...(value.frames === true ? { frames: true } : {}),
    ...(typeof value.since === 'string' ? { since: value.since } : {}),
    ...(typeof value.maxElements === 'number' ? { maxElements: value.maxElements } : {}),
    ...(typeof value.maxDepth === 'number' ? { maxDepth: value.maxDepth } : {}),
  }
}

/** A typed action, or `INVALID_PARAMS`: a malformed one never reaches the driver. */
function action(value: unknown): ComputerAction {
  const parsed = parseComputerAction(value) ?? invalid('not a computer action')
  try {
    assertAction(parsed)
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error))
  }
  return parsed
}

/**
 * `ctx.computer` as the daemon serves it. Served only when the person started
 * the daemon with computer use on; `guard` lets them pause it at any time,
 * and while paused every call (looking included) is refused.
 */
export function exposeComputer(computer: DaemonComputer, guard?: DaemonComputerGuard): ExposedService {
  const allowed = (): void => {
    const reason = guard?.paused()
    if (reason !== undefined) throw new ComputerError('COMPUTER_DENIED', reason)
  }
  return {
    calls: {
      windows: (_args, { signal }) => { allowed(); return computer.windows({ signal }) },
      apps: (_args, { signal }) => { allowed(); return computer.apps({ signal }) },
      screenshot: ([id], { signal }) => { allowed(); return computer.screenshot(windowId(id), { signal }) },
      zoom: ([id, area], { signal }) => { allowed(); return computer.zoom(windowId(id), region(area), { signal }) },
      tree: ([id, options], { signal }) => { allowed(); return computer.tree(windowId(id), { ...treeOptions(options), signal }) },
      act: ([value], { signal }) => {
        const typed = action(value)
        allowed()
        guard?.onAction?.(typed)
        return computer.act(typed, { signal })
      },
    },
  }
}
