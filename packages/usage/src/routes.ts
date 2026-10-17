import { readSystemConfig } from '@tnega/config'
import type { Context } from '@tnega/core'
import { sendError, sendJson, workspaceParam } from '@tnega/web-kit'
import { storedWorkspaceUsage } from './index.js'

export interface UsageRoutesConfig {
  configFile?: string
}

/** Workspace usage rollups; this package owns the usage store. */
export const usageRoutes = {
  name: 'usage-routes',
  inject: ['webServer'],
  apply(ctx: Context, config: UsageRoutesConfig): void {
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'GET',
      path: '/api/usage',
      handler: async (_req, res, url) => {
        const workspace = workspaceParam(url)
        if (!workspace) {
          sendError(res, 400, 'workspace query parameter is required')
          return
        }
        sendJson(res, 200, await storedWorkspaceUsage(workspace, await readSystemConfig(config.configFile)))
      },
    }))
  },
}
