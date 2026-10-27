import type { Context } from '@tnega/core'
import { SecretError } from '@tnega/secrets'
import { sendError, sendJson, workspaceParam } from '@tnega/web-kit'
import type { SecretScope, SecretVault } from './index.js'

const SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/

function scopeOf(url: URL): SecretScope | undefined {
  const workspace = workspaceParam(url)
  // Without a session only the workspace's saved secrets are listed.
  const sessionId = url.searchParams.get('session') ?? ''
  if (!workspace || (sessionId && !SESSION_ID.test(sessionId))) return undefined
  return { workspace, sessionId }
}

export interface SecretRoutesConfig {
  vault: SecretVault
}

/**
 * Names, never values: `GET /api/secrets` lists a Session's secrets and
 * `DELETE /api/secrets?name=` forgets one. Setting a secret only happens by
 * answering the agent's question.
 */
export const secretRoutes = {
  name: 'secret-routes',
  inject: ['webServer'],
  apply(ctx: Context, config: SecretRoutesConfig): void {
    for (const method of ['GET', 'DELETE'] as const) {
      ctx.fiber.effect(() => ctx.webServer.register({
        kind: 'exact',
        method,
        path: '/api/secrets',
        handler: async (req, res, url) => {
          const scope = scopeOf(url)
          if (!scope) {
            sendError(res, 400, 'a workspace query parameter and a valid session id are required')
            return
          }
          try {
            if (req.method === 'DELETE') {
              const name = url.searchParams.get('name') ?? ''
              if (!await config.vault.remove(scope, name)) {
                sendError(res, 404, 'No secret with that name')
                return
              }
            }
            sendJson(res, 200, { secrets: await config.vault.list(scope) })
          } catch (error) {
            if (!(error instanceof SecretError)) throw error
            sendError(res, error.code === 'SECRET_INVALID' ? 400 : 500, error.message)
          }
        },
      }), 'secret-routes')
    }
  },
}
