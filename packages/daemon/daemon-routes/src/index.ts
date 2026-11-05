import type { Context } from '@tnega/core'
import { browserRoutes, type PlaywrightBrowserHost } from '@tnega/browser-playwright'
import { computerSetupRoutes } from '@tnega/computer-cua'
import { folderPickerRoutes } from '@tnega/directory-picker'
import { fsLocal } from '@tnega/fs-local'
import { sandboxSetupRoutes } from '@tnega/sandbox-local'
import { terminalLocal } from '@tnega/terminal-local'
import { terminalRoutes } from '@tnega/terminal-routes'
import { fileRoutes } from '@tnega/workspace-files'

export interface DaemonRoutesConfig {
  /**
   * The agent browser the Workbench shows. The host owns it, because the
   * agent's `browser_*` tools drive the same page; absent means no browser.
   */
  browser?: () => PlaywrightBrowserHost | undefined
  /** Where the computer-use driver lives, when the person set it. */
  computerDriverPath?: string
}

/**
 * The machine-side HTTP routes: Workbench files, terminals and browser, plus
 * the folder picker and the sandbox and computer-use setup hints. They all
 * act on the machine the person sits at, so they are mounted from the daemon
 * side; a host that serves no local machine leaves this plugin out and those
 * URLs answer 404. URLs and responses are the same as when the host mounted
 * them itself.
 */
export const daemonRoutes = {
  name: 'daemon-routes',
  inject: ['webServer'],
  async apply(ctx: Context, config: DaemonRoutesConfig = {}): Promise<void> {
    // Workbench files are this machine's; a server reads them through a daemon instead.
    await ctx.plugin(fsLocal)
    await ctx.plugin(fileRoutes)
    await ctx.plugin(browserRoutes, { browser: config.browser ?? (() => undefined) })
    await ctx.plugin(folderPickerRoutes)
    await ctx.plugin(sandboxSetupRoutes)
    // Registered whether or not computer use is on: the hint's job is to explain
    // the missing driver before someone wonders why the tools are absent.
    await ctx.plugin(computerSetupRoutes, config.computerDriverPath ? { driverPath: config.computerDriverPath } : {})
    // Terminals die with this plugin, after their routes are gone.
    await ctx.plugin(terminalLocal)
    await ctx.plugin(terminalRoutes)
  },
}

export const name = '@tnega/daemon-routes'
