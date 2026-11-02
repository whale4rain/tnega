import type { Context } from '@tnega/core'
import type { ComputerAction, ComputerPreActionEvent } from '@tnega/computer'

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

const CLICK_OPS: ReadonlySet<ComputerAction['op']> = new Set(['click', 'scroll', 'hover', 'menu', 'launch'])

/**
 * One spelling for an app: lower case, no folder, no `.exe` / `.app`, so
 * "Notepad", "notepad.exe" and `C:\Windows\notepad.exe` are the same app.
 */
export function appKey(name: string): string {
  const last = name.trim().split(/[\\/]/).pop() ?? ''
  return last.toLowerCase().replace(/\.(exe|app)$/, '')
}

/** The tier that applies to an app. */
export function tierOf(app: string, config: ComputerTiersConfig): ComputerTier {
  const apps = typeof config.apps === 'function' ? config.apps() : config.apps
  const key = appKey(app)
  for (const [name, tier] of Object.entries(apps ?? {})) {
    if (appKey(name) === key && COMPUTER_TIERS.includes(tier)) return tier
  }
  return config.fallback ?? 'full'
}

/** Why a tier refuses an action, or `undefined` when it allows it. */
export function refusal(action: ComputerAction, app: string, tier: ComputerTier): string | undefined {
  if (tier === 'full') return undefined
  // Starting an app is not input to it, but URLs make it browse.
  if (action.op === 'launch' && !(action.urls?.length)) return undefined
  if (tier === 'click' && CLICK_OPS.has(action.op)) return undefined
  const allowed = tier === 'look' ? 'only look at it (screenshots and reading)' : 'only click, scroll, hover and use menus in it, not type, press keys or drag'
  return `${app} is set to "${tier}" in Settings: you may ${allowed}. Do not try another way around this; ask the user if the task needs more.`
}

export const name = 'computer-tiers'

/**
 * Policy on `computer/pre-action`: refuse what an app's tier does not allow.
 * Each step of a batch is judged on its own, so a batch cannot carry a
 * refused step. Actions with no app (the clipboard) are not tiered.
 */
export function apply(ctx: Context, config: ComputerTiersConfig = {}): void {
  ctx.on('computer/pre-action', (event: ComputerPreActionEvent, next: () => Promise<unknown>) => {
    const app = event.window?.app ?? (event.action.op === 'launch' ? event.action.app : undefined)
    if (app !== undefined && event.deny === undefined) {
      const reason = refusal(event.action, app, tierOf(app, config))
      if (reason) event.deny = reason
    }
    return next()
  })
}

/** Mount: `await ctx.plugin(computerTiers, { apps })`. */
export const computerTiers = {
  name,
  apply,
}
