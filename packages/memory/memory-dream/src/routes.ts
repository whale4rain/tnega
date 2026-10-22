import type { Context } from '@tnega/core'
import { errorMessage, sendError, sendJson, workspaceParam } from '@tnega/web-kit'
import './service.js'

/**
 * `GET /api/memory/dream?workspace=` reports the last dream;
 * `POST` dreams that workspace now, including sessions that are still active.
 */
export const memoryDreamRoutes = {
  name: 'memory-dream-routes',
  inject: ['webServer', 'memoryDream'],
  apply(ctx: Context): void {
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'GET',
      path: '/api/memory/dream',
      handler: async (_req, res, url) => {
        const workspace = workspaceParam(url)
        if (!workspace) { sendError(res, 400, 'workspace query parameter is required'); return }
        sendJson(res, 200, await ctx.memoryDream.state(workspace))
      },
    }))
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'POST',
      path: '/api/memory/dream',
      handler: async (_req, res, url) => {
        const workspace = workspaceParam(url)
        if (!workspace) { sendError(res, 400, 'workspace query parameter is required'); return }
        try {
          sendJson(res, 200, await ctx.memoryDream.dream(workspace, { idleMs: 0 }))
        } catch (error) {
          sendError(res, 500, errorMessage(error))
        }
      },
    }))
  },
}
