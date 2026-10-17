import type { Context } from '@tnega/core'
import { readJsonBody, sendError, sendJson, workspaceParam } from '@tnega/web-kit'
import { readWorkspacePrompt, writeWorkspacePrompt } from './index.js'

/** The workspace prompt (AGENTS.md-style instructions) endpoints. */
export const workspacePromptRoutes = {
  name: 'workspace-prompt-routes',
  inject: ['webServer'],
  apply(ctx: Context): void {
    for (const method of ['GET', 'PUT'] as const) {
      ctx.fiber.effect(() => ctx.webServer.register({
        kind: 'exact',
        method,
        path: '/api/workspace-prompt',
        handler: async (req, res, url) => {
          const workspace = workspaceParam(url)
          if (!workspace) {
            sendError(res, 400, 'workspace query parameter is required')
            return
          }
          if (req.method === 'PUT') {
            const body = await readJsonBody(req)
            if (typeof body.prompt !== 'string' || body.prompt.length > 32000) {
              sendError(res, 400, 'prompt must be a string of at most 32000 characters')
              return
            }
            await writeWorkspacePrompt(workspace, body.prompt)
          }
          sendJson(res, 200, { prompt: await readWorkspacePrompt(workspace) })
        },
      }))
    }
  },
}
