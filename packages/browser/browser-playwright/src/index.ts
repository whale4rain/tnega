import type { Context } from '@tnega/core'
import {
  BrowserService,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserCallOptions,
  type BrowserConsoleEntry,
  type BrowserLogQuery,
  type BrowserNetworkEntry,
  type BrowserPageState,
  type BrowserScreenshot,
  type BrowserSnapshot,
} from '@tnega/browser'
import { PlaywrightBrowserHost, type BrowserHostOptions } from './host.js'
import { launchPageSource, type LaunchSourceOptions } from './source.js'

export { PlaywrightBrowserHost, evaluationSource, type BrowserHostOptions } from './host.js'
export {
  DEFAULT_VIEWPORT,
  cdpPageSource,
  launchPageSource,
  type CdpSourceOptions,
  type LaunchSourceOptions,
  type PageSource,
} from './source.js'

export interface Config extends BrowserHostOptions {
  /**
   * A host shared beyond this plugin, e.g. the desktop app's embedded view.
   * The plugin never closes a host it was given.
   */
  host?: PlaywrightBrowserHost
  /** Without a host, launch a browser with these options; it closes with the plugin. */
  launch?: LaunchSourceOptions
}

/** Service Provider of `ctx.browser`, backed by Playwright. */
export class PlaywrightBrowser extends BrowserService {
  constructor(ctx: Context, private readonly _host: PlaywrightBrowserHost) {
    super(ctx)
  }

  page(): BrowserPageState {
    return this._host.state()
  }

  protected runAction(action: BrowserAction, options: BrowserCallOptions): Promise<BrowserActionResult> {
    return this._host.run(action, options)
  }

  snapshot(options?: BrowserCallOptions): Promise<BrowserSnapshot> {
    return this._host.snapshot(options)
  }

  screenshot(options?: BrowserCallOptions & { fullPage?: boolean; ref?: string }): Promise<BrowserScreenshot> {
    return this._host.screenshot(options)
  }

  console(query?: BrowserLogQuery): BrowserConsoleEntry[] {
    return this._host.console(query)
  }

  network(query?: BrowserLogQuery): BrowserNetworkEntry[] {
    return this._host.network(query)
  }

  evaluate(expression: string, options?: BrowserCallOptions): Promise<unknown> {
    return this._host.evaluate(expression, options)
  }
}

export const name = '@tnega/browser-playwright'

/** Mount: `await ctx.plugin(browserPlaywright, { host })` or `{ launch: { headless: true } }`. */
export const browserPlaywright = {
  name: 'browser-playwright',
  apply(ctx: Context, config: Config = {}) {
    const owned = config.host ? undefined : new PlaywrightBrowserHost(launchPageSource(config.launch), config)
    new PlaywrightBrowser(ctx, config.host ?? owned!)
    if (owned) ctx.fiber.effect(() => () => { void owned.close() }, 'browser-playwright/close')
  },
}
