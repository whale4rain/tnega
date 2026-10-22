import type { Context } from '@tnega/core'
import { MXC_INSTALL_COMMAND, MXC_INSTALL_URL, mxcSetup, type MxcSetup } from '@tnega/sandbox-windows-mxc'
import { sendJson } from '@tnega/web-kit'

/** `GET /api/sandbox/setup`：本机沙箱还能装什么更好的机制。 */
export interface SandboxSetup {
  mxc: MxcSetup
  install: { command: string; url: string }
}

/**
 * 只读的安装提示，不探测、不起进程：Windows 24H2+ 上找不到 MXC 执行器时，界面据此提示
 * 安装。真正选用哪个机制仍由 Provider 的功能性探测决定。
 */
export const sandboxSetupRoutes = {
  name: 'sandbox-setup',
  inject: ['webServer'],
  apply(ctx: Context): void {
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'GET',
      path: '/api/sandbox/setup',
      handler: (_req, res) => {
        const body: SandboxSetup = {
          mxc: mxcSetup(),
          install: { command: MXC_INSTALL_COMMAND, url: MXC_INSTALL_URL },
        }
        sendJson(res, 200, body)
      },
    }))
  },
}
