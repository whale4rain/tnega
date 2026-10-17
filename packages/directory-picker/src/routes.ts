import type { Context } from '@tnega/core'
import { isLoopbackAddress, sendError, sendJson } from '@tnega/web-kit'
import { pickSystemFolder } from './index.js'

/** The native folder picker, available to loopback clients only. */
export const folderPickerRoutes = {
  name: 'folder-picker-routes',
  inject: ['webServer'],
  apply(ctx: Context): void {
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'POST',
      path: '/api/folder-picker',
      handler: async (req, res) => {
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          sendError(res, 403, 'folder picker is only available to local clients')
          return
        }
        const path = await pickSystemFolder()
        sendJson(res, 200, path ? { path } : {})
      },
    }))
  },
}
