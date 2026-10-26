import { Context } from '@tnega/core'
import { MXC_INSTALL_COMMAND, MXC_INSTALL_URL, mxcSetup, type MxcSetup } from '@tnega/sandbox-windows-mxc'
import { sendJson } from '@tnega/web-kit'

/** `GET /api/sandbox/setup`：本机沙箱还能装什么更好的机制。 */
export interface SandboxSetup {
  mxc: MxcSetup
  install: { command: string; url: string }
}

/**
 * `GET /api/sandbox/network`：这台机器的沙箱能否按域名过滤命令的网络。`filtering` 为假时
 * `detail` 说明原因；那时选「只允许列出的域名」或「关闭」会让命令 fail closed，而不是放开跑。
 */
export interface SandboxNetworkSupport {
  filtering: boolean
  runner?: string
  detail?: string
}

/** 在一个独立的作用域里探测一次本机机制（会起进程），结果按宿主生命周期缓存。 */
async function probeNetworkSupport(): Promise<SandboxNetworkSupport> {
  const { LocalSandboxService } = await import('./index.js')
  const scope = new Context()
  try {
    const status = await new LocalSandboxService(scope).status()
    if (!status.available) return { filtering: false, detail: status.detail ?? 'no sandbox mechanism works on this machine' }
    return {
      filtering: status.network?.filtering ?? false,
      ...(status.runner !== undefined ? { runner: status.runner } : {}),
      ...(status.network?.detail !== undefined ? { detail: status.network.detail } : {}),
    }
  } finally {
    await scope.fiber.dispose()
  }
}

/**
 * 只读的安装提示，不探测、不起进程：Windows 24H2+ 上找不到 MXC 执行器时，界面据此提示
 * 安装。真正选用哪个机制仍由 Provider 的功能性探测决定。
 */
export const sandboxSetupRoutes = {
  name: 'sandbox-setup',
  inject: ['webServer'],
  apply(ctx: Context): void {
    let support: Promise<SandboxNetworkSupport> | undefined
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'GET',
      path: '/api/sandbox/network',
      handler: async (_req, res) => {
        support ??= probeNetworkSupport()
        sendJson(res, 200, await support)
      },
    }))
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
