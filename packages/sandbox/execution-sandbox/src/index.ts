import type { Context } from '@tnega/core'
import {
  localExecutionProvider,
  type ExecutionProvider,
  type ProcessRequest,
  type ShellRequest,
} from '@tnega/execution'
import {
  SandboxService,
  type SandboxExecutionPolicy,
  type SandboxOp,
} from '@tnega/sandbox'

/**
 * 把 `shell` 工具的命令装成一个显式 argv 再交给沙箱。
 *
 * 这一点是「内建命令、管道、重定向仍然工作」的原因：包装发生在 **argv 层**，
 * 命令字符串要么作为 `-c` 的单个参数交给 shell，要么由 `cmd /c` 自己解析；中间不
 * 存在第二层引号，也没有把命令拆开重组的步骤。
 */
export interface SandboxedShell {
  readonly command: string
  readonly args: readonly string[]
}

export interface SandboxedExecutionConfig {
  /** 真正落进程的实现；默认 `localExecutionProvider`。 */
  inner?: ExecutionProvider
  /** 本次 Agent Run 的权限预设。`bypass` 表示不沙箱，直接透传。 */
  policy: SandboxExecutionPolicy
  /** POSIX shell；默认 `/bin/sh`（`shell: true` 在 POSIX 上的等价物）。 */
  shellPath?: string
  /** Windows 上承载命令的解释器；默认取 `%ComSpec%`。 */
  shell?: SandboxedShell
  /**
   * 是否把无 shell 的 argv 进程也包进沙箱。默认 `true`：搜索 Provider 走的
   * `runProcess` 只读，但一个只读进程同样不该有工作区外的写权限。
   */
  confineProcess?: boolean
}

/** Windows 上 `shell: true` 真正使用的解释器。 */
function defaultWindowsShell(): SandboxedShell {
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c'],
  }
}

function shellArgv(request: ShellRequest, config: SandboxedExecutionConfig): string[] {
  if (process.platform !== 'win32') {
    return [config.shellPath ?? '/bin/sh', '-c', request.command]
  }
  const shell = config.shell ?? defaultWindowsShell()
  return [shell.command, ...shell.args, request.command]
}

/**
 * `ctx.sandbox` 的 Consumer：一个 `ExecutionProvider` 装饰器。
 *
 * 它只 import Service Definition，不认识任何具体 Provider（不 import
 * `@tnega/sandbox-local`，也不枚举后端），因此换 Provider 是 composition 层的
 * 一行挂载变化。真正的机制选择、功能性探测与 fail-closed 都在 Provider 内。
 *
 * 失败语义：Provider 交不出受限 argv 时 `confine` 会抛出，这里**不捕获**——
 * 「宿主上无法沙箱」必须让调用方看见并放弃执行，而不是回退到非受限执行。
 *
 * 网络（`fetchHttp`）直接透传：当前没有任何后端限制网络，词汇里也没有这一维。
 */
export function sandboxedExecution(
  ctx: Context,
  config: SandboxedExecutionConfig,
): ExecutionProvider {
  const inner = config.inner ?? localExecutionProvider
  const confineProcess = config.confineProcess ?? true

  function requireSandbox(): SandboxService {
    const service = ctx.get('sandbox')
    if (!(service instanceof SandboxService)) {
      throw new Error(
        'sandboxed execution requires a mounted sandbox provider (ctx.sandbox); '
        + 'mount @tnega/sandbox-local in the composition or run with bypass',
      )
    }
    return service
  }

  async function confine(
    op: SandboxOp,
    argv: readonly string[],
    request: { signal?: AbortSignal },
  ): Promise<string[]> {
    const confined = await requireSandbox().confine({
      op,
      argv,
      policy: config.policy,
      ...(request.signal ? { signal: request.signal } : {}),
    })
    return confined.argv
  }

  return {
    async runShell(request: ShellRequest) {
      if (config.policy.mode === 'bypass') return inner.runShell(request)
      const argv = await confine('shell', shellArgv(request, config), request)
      const result = await inner.runProcess({
        argv,
        cwd: request.cwd,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.maxBuffer !== undefined ? { maxBuffer: request.maxBuffer } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      })
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    },

    async runProcess(request: ProcessRequest) {
      if (config.policy.mode === 'bypass' || !confineProcess) return inner.runProcess(request)
      const argv = await confine('process', request.argv, request)
      return inner.runProcess({ ...request, argv })
    },

    fetchHttp(request) {
      return inner.fetchHttp(request)
    },
  }
}

export type { ExecutionProvider } from '@tnega/execution'
