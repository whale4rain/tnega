import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@tnega/core'
import type { ProjectHost } from '@tnega/project-host'
import { readJsonBody, sendError, sendJson, workspaceParam, writeSse } from '@tnega/web-kit'
import { handleProjectApi } from './project-routes.js'

export interface ProjectRoutesConfig {
  /** One Project Host per workspace; the host caches and recycles them. */
  host(workspace: string): Promise<ProjectHost>
}

/** The Project HTTP surface, registered by this package on the shared table. */
export const projectApi = {
  name: 'project-api-routes',
  inject: ['webServer'],
  apply(ctx: Context, config: ProjectRoutesConfig): void {
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'prefix',
      method: '*',
      path: '/api/projects',
      handler: (req: IncomingMessage, res: ServerResponse, url: URL) => handleProjectApi(req, res, url, {
        host: config.host,
        sendJson,
        sendError,
        readJsonBody,
        writeSse,
        workspaceParam,
      }),
    }))
  },
}
