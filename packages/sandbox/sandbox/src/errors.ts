import type { ConfinedSandboxMode } from './types.js'

/** 稳定、可路由的沙箱失败码。 */
export type SandboxErrorCode =
  /** 宿主上没有任何可用后端：**拒绝以非受限方式执行**。 */
  | 'SANDBOX_UNAVAILABLE'
  /** 请求的策略自相矛盾（bypass 被送进沙箱、workspaceRoot 不是绝对路径……）。 */
  | 'SANDBOX_INVALID_POLICY'
  /** 要执行的 argv 非法（空、含非字符串、缺少可执行名）。 */
  | 'SANDBOX_INVALID_ARGV'
  /** Provider 交出的受限 argv 不合法。 */
  | 'SANDBOX_INVALID_RESULT'

/** `SANDBOX_UNAVAILABLE` 的常量形态，供只做字符串比较的调用方使用。 */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE' satisfies SandboxErrorCode

/** 带稳定错误码的沙箱失败。 */
export class SandboxError extends Error {
  override name = 'SandboxError'

  constructor(
    message: string,
    readonly code: SandboxErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * 没有任何可用后端时抛出的错误。
 *
 * 它存在的意义是让调用方把「宿主缺沙箱」与「命令自己失败了」分开：拿到这个码的
 * 调用方**必须**放弃执行，而不是回退到非受限执行。
 */
export class SandboxUnavailableError extends SandboxError {
  override name = 'SandboxUnavailableError'

  constructor(mode: ConfinedSandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; `
      + 'refusing to run the command unconfined. Install bubblewrap or run a '
      + 'Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure '
      + 'MXC (wxc-exec.exe) or the ACL restricted-token runner can start (Windows) — otherwise run with bypass.',
      'SANDBOX_UNAVAILABLE',
    )
    if (detail !== undefined) this.message += ` Runner failure: ${detail}`
  }
}
