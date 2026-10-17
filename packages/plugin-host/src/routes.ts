import type { Context } from '@tnega/core'
import { sendError, sendJson } from '@tnega/web-kit'
import type { HotPluginHost, PluginWorkshop } from './index.js'

export interface PluginRoutesConfig {
  /** The hot profile, when the host runs with one. */
  profile(): HotPluginHost | undefined
  /** The dev workshop, when plugin development is enabled. */
  workshop(): PluginWorkshop | undefined
}

/** Plugin status and reload endpoints; the plugin host owns this state. */
export const pluginRoutes = {
  name: 'plugin-routes',
  inject: ['webServer'],
  apply(ctx: Context, config: PluginRoutesConfig): void {
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'GET',
      path: '/api/plugins',
      handler: async (_req, res) => {
        const profile = config.profile()
        const workshop = config.workshop()
        sendJson(res, 200, {
          ...(profile ? { enabled: true, ...profile.status() } : { enabled: false }),
          dev: workshop
            ? { enabled: true, dir: workshop.dir, ...workshop.host.status(), plugins: (await workshop.list()).map(plugin => plugin.name) }
            : { enabled: false },
        })
      },
    }))
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'POST',
      path: '/api/plugins/reload',
      handler: async (_req, res) => {
        const profile = config.profile()
        if (!profile) {
          sendError(res, 404, 'plugin profile is not enabled')
          return
        }
        sendJson(res, 200, { enabled: true, ...await profile.reload() })
      },
    }))
  },
}
