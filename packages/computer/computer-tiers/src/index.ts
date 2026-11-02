import type { Context } from '@tnega/core'
import type { ComputerAction, ComputerPreActionEvent, ComputerWindow } from '@tnega/computer'

/**
 * How far the agent may go in one app.
 *
 * - `look`: screenshots and reading only; every action in the app is refused.
 * - `click`: click, scroll, hover and menus; no typing, keys or drags.
 * - `full`: everything.
 */
export type ComputerTier = 'look' | 'click' | 'full'

export const COMPUTER_TIERS: readonly ComputerTier[] = ['look', 'click', 'full']

export interface ComputerTiersConfig {
  /** Tier by app name as the user wrote it, e.g. `{ "Notepad": "look" }`. Read on every action. */
  apps?: Readonly<Record<string, ComputerTier>> | (() => Readonly<Record<string, ComputerTier>> | undefined)
  /** Tier of every app not listed (default `full`). */
  fallback?: ComputerTier
}

const CLICK_OPS: ReadonlySet<ComputerAction['op']> = new Set(['click', 'scroll', 'hover', 'menu'])

/**
 * One spelling for an app: lower case, no folder, no `.exe` / `.app`, so
 * "Notepad", "notepad.exe" and `C:\Windows\notepad.exe` are the same app.
 */
export function appKey(name: string): string {
  const last = name.trim().split(/[\\/]/).pop() ?? ''
  return last.toLowerCase().replace(/\.(exe|app)$/, '')
}

function limitsOf(config: ComputerTiersConfig): Array<[string, ComputerTier]> {
  const apps = typeof config.apps === 'function' ? config.apps() : config.apps
  return Object.entries(apps ?? {}).filter(([name, tier]) => name.trim() !== '' && COMPUTER_TIERS.includes(tier))
}

/** The limit set for an app under any of its names, if one is. */
function listedTier(names: readonly string[], config: ComputerTiersConfig): ComputerTier | undefined {
  const keys = new Set(names.map(appKey))
  return limitsOf(config).find(([name]) => keys.has(appKey(name)))?.[1]
}

/** The tier that applies to an app known by these names (process name, display name). */
export function tierOf(app: string | readonly string[], config: ComputerTiersConfig): ComputerTier {
  return listedTier(typeof app === 'string' ? [app] : app, config) ?? config.fallback ?? 'full'
}

/** Why a tier refuses an action, or `undefined` when it allows it. */
export function refusal(action: ComputerAction, app: string, tier: ComputerTier): string | undefined {
  if (tier === 'full') return undefined
  if (tier === 'click' && CLICK_OPS.has(action.op)) return undefined
  const allowed = tier === 'look' ? 'only look at it (screenshots and reading)' : 'only click, scroll, hover and use menus in it, not type, press keys or drag'
  return `${app} is set to "${tier}" in Settings: you may ${allowed}. Do not try another way around this; ask the user if the task needs more.`
}

export const name = 'computer-tiers'

/**
 * Policy on `computer/pre-action`: refuse what the tier of the app that owns
 * the target window does not allow. Each step of a batch is judged on its
 * own, so a batch cannot carry a refused step.
 *
 * Not tiered: actions with no window. The clipboard belongs to no app, and
 * starting an app is not input to it; URLs it opens are navigation, which
 * every tier allows (an app started by name may hand them to the default
 * browser, so the receiving app is not known here anyway).
 *
 * A window matches a limit by its process name (`chrome.exe`) or by its
 * display name from `ctx.computer.apps()` (`Google Chrome`), so either name
 * from the app list works in Settings. When limits are set, the window's
 * process name matches none of them, and the app list cannot be read, the
 * action is refused: the limit might have applied.
 */
export function apply(ctx: Context, config: ComputerTiersConfig = {}): void {
  // Display names by process id; only found names are kept, since a new app may not be listed yet.
  const displayNames = new Map<number, string>()
  const displayName = async (window: ComputerWindow): Promise<string | undefined> => {
    const known = displayNames.get(window.pid)
    if (known !== undefined) return known
    const owner = (await ctx.computer.apps()).find(app => app.windowIds.includes(window.id) || (app.pid !== undefined && app.pid === window.pid))
    if (owner) displayNames.set(window.pid, owner.name)
    return owner?.name
  }
  const tierFor = async (window: ComputerWindow): Promise<ComputerTier | string> => {
    const direct = listedTier([window.app], config)
    if (direct !== undefined || limitsOf(config).length === 0) return direct ?? config.fallback ?? 'full'
    let name: string | undefined
    try {
      name = await displayName(window)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return `App limits are set in Settings, and it could not be checked which app owns this window (${reason}), so the action was not done.`
    }
    return tierOf(name === undefined ? [window.app] : [window.app, name], config)
  }
  ctx.on('computer/pre-action', async (event: ComputerPreActionEvent, next: () => Promise<unknown>) => {
    if (event.window && event.deny === undefined) {
      const tier = await tierFor(event.window)
      const reason = isTier(tier) ? refusal(event.action, event.window.app, tier) : tier
      if (reason) event.deny = reason
    }
    return await next()
  })
}

function isTier(value: string): value is ComputerTier {
  return COMPUTER_TIERS.some(tier => tier === value)
}

/** Mount: `await ctx.plugin(computerTiers, { apps })`; needs `ctx.computer`. */
export const computerTiers = {
  name,
  inject: ['computer'],
  apply,
}
