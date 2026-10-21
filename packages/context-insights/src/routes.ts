import { readSystemConfig } from '@tnega/config'
import type { Context } from '@tnega/core'
import { isSessionId } from '@tnega/session-store'
import { sendError, sendJson, workspaceParam } from '@tnega/web-kit'
import { contextInsights, isInsightsRange } from './insights.js'
import { ContextReportStore } from './store.js'

export interface ContextInsightsConfig {
  configFile?: string
}

/**
 * Serves what a session's context is made of (`GET /api/context`) and the
 * workspace-wide roll-up (`GET /api/context-insights`). Both read the durable
 * session logs; the plugin owns a small in-memory report cache that is
 * dropped when the plugin is disposed.
 */
export const contextInsightsRoutes = {
  name: 'context-insights',
  inject: ['webServer'],
  apply(ctx: Context, config: ContextInsightsConfig): void {
    const store = new ContextReportStore()
    ctx.fiber.effect(() => () => store.clear())
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'GET',
      path: '/api/context',
      handler: async (_req, res, url) => {
        const workspace = workspaceParam(url)
        const id = url.searchParams.get('session') ?? ''
        if (!workspace) return sendError(res, 400, 'workspace query parameter is required')
        if (!isSessionId(id)) return sendError(res, 400, 'invalid session id')
        const report = await store.session(workspace, id, await readSystemConfig(config.configFile))
        if (!report) return sendError(res, 404, 'session not found')
        sendJson(res, 200, report)
      },
    }))
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'GET',
      path: '/api/context-insights',
      handler: async (_req, res, url) => {
        const workspace = workspaceParam(url)
        if (!workspace) return sendError(res, 400, 'workspace query parameter is required')
        const range = url.searchParams.get('range') ?? '30d'
        if (!isInsightsRange(range)) return sendError(res, 400, 'range must be today, 7d, 30d or all')
        const sources = await store.workspace(workspace, await readSystemConfig(config.configFile))
        sendJson(res, 200, contextInsights(sources, range))
      },
    }))
  },
}
