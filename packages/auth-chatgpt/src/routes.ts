import type { Context } from '@tnega/core'
import { sendError, sendJson } from '@tnega/web-kit'
import { ChatGptLogin } from './index.js'

export interface ChatGptRoutesConfig {
  /** Host policy for a fresh sign-in (e.g. adding the ChatGPT model route). */
  onSignedIn(): Promise<void>
}

/** The ChatGPT sign-in endpoints; the login session dies with this plugin. */
export const chatgptRoutes = {
  name: 'chatgpt-auth-routes',
  inject: ['webServer'],
  apply(ctx: Context, config: ChatGptRoutesConfig): void {
    let login: ChatGptLogin | undefined
    ctx.fiber.effect(() => () => {
      void login?.stop()
    })
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: '*',
      path: '/api/auth/chatgpt',
      handler: async (req, res) => {
        login ??= new ChatGptLogin({ onSignedIn: config.onSignedIn })
        if (req.method === 'GET') {
          sendJson(res, 200, await login.state())
          return
        }
        if (req.method === 'POST') {
          try {
            sendJson(res, 200, await login.start())
          } catch (error) {
            sendError(res, 409, error instanceof Error ? error.message : String(error))
          }
          return
        }
        if (req.method === 'DELETE') {
          await login.signOut()
          sendJson(res, 200, await login.state())
          return
        }
        sendError(res, 404, 'not found')
      },
    }))
  },
}
