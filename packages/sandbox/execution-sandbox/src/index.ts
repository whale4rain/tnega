import type { Context } from '@tnega/core'
import {
  isMsysShell,
  isSandboxPipeDenial,
  SANDBOX_PIPE_HINT,
  type BackgroundProcess,
  localExecutionProvider,
  shellCommandArgv,
  systemShell,
  type SystemShell,
  type BackgroundProcessRequest,
  type BackgroundShellRequest,
  type ExecutionProvider,
  type ProcessRequest,
  type ShellRequest,
} from '@tnega/execution'
import {
  SandboxService,
  type SandboxExecutionPolicy,
  type SandboxOp,
  type ConfinedArgv,
} from '@tnega/sandbox'

export interface SandboxedExecutionConfig {
  /** 真正落进程的实现；默认 `localExecutionProvider`。 */
  inner?: ExecutionProvider
  /** 本次 Agent Run 的权限预设。`bypass` 表示不沙箱，直接透传。 */
  policy: SandboxExecutionPolicy
  /**
   * Optional Session-backed policy resolver. It is read immediately before an
   * execution so a resident Agent Runtime follows durable permission changes.
   */
  resolvePolicy?: () => SandboxExecutionPolicy | Promise<SandboxExecutionPolicy>
  /**
   * 承载命令的系统 shell；默认与非沙箱路径相同（`systemShell()`）。命令始终作为单个
   * argv 元素（PowerShell 为 `-EncodedCommand`）交给 shell，中间不存在第二层引号。
   */
  shell?: SystemShell
  /**
   * 是否把无 shell 的 argv 进程也包进沙箱。默认 `true`：搜索 Provider 走的
   * `runProcess` 只读，但一个只读进程同样不该有工作区外的写权限。
   */
  confineProcess?: boolean
}

/**
 * The Windows write sandbox cannot let a process create named pipes for its
 * children (Node/libuv `spawn` with captured output, npm scripts that start
 * vite or esbuild…): the pipe's default DACL only lets its owner write, and the
 * owner is not in the token's restricting list. Widening the list would undo
 * the write fence, so the command fails; this tells the agent how to proceed.
 */
export { SANDBOX_PIPE_HINT }

function withPipeHint(result: { exitCode: number; stdout: string; stderr: string }): { exitCode: number; stdout: string; stderr: string } {
  if (process.platform !== 'win32' || result.exitCode === 0) return result
  if (!isSandboxPipeDenial(`${result.stdout}\n${result.stderr}`)) return result
  return { ...result, stderr: `${result.stderr}${result.stderr.endsWith('\n') || !result.stderr ? '' : '\n'}${SANDBOX_PIPE_HINT}\n` }
}

/** Tell the process tools a background process runs confined, so they can explain its failures. */
function markSandboxed(process: BackgroundProcess, sandboxed: boolean): BackgroundProcess {
  if (!sandboxed) return process
  return {
    get pid() { return process.pid },
    sandboxed: true,
    output: () => process.output(),
    exitCode: () => process.exitCode(),
    exited: process.exited,
    kill: () => process.kill(),
  }
}

function shellArgv(request: ShellRequest, config: SandboxedExecutionConfig, confined = true): string[] {
  const shell = config.shell ?? systemShell()
  // Fail closed with a reason instead of Cygwin's cryptic CreateFileMapping crash.
  if (confined && process.platform === 'win32' && isMsysShell(shell)) {
    throw new Error(`${shell.label} cannot run inside the Windows sandbox; choose PowerShell as the shell or run with bypass permissions`)
  }
  return shellCommandArgv(shell, request.command)
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

  async function policy(): Promise<SandboxExecutionPolicy> {
    return config.resolvePolicy?.() ?? config.policy
  }

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
    activePolicy: SandboxExecutionPolicy,
  ): Promise<Pick<ConfinedArgv, 'argv' | 'env'>> {
    const confined = await requireSandbox().confine({
      op,
      argv,
      policy: activePolicy,
      ...(request.signal ? { signal: request.signal } : {}),
    })
    return { argv: confined.argv, ...(confined.env ? { env: confined.env } : {}) }
  }

  return {
    async runShell(request: ShellRequest) {
      const activePolicy = await policy()
      // An approved escalation runs as the user would; the approval was the gate.
      if (activePolicy.mode === 'bypass' || request.unsandboxed) return inner.runShell(request)
      const confined = await confine('shell', shellArgv(request, config), request, activePolicy)
      const result = await inner.runProcess({
        ...confined,
        cwd: request.cwd,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.maxBuffer !== undefined ? { maxBuffer: request.maxBuffer } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.onOutput ? { onOutput: request.onOutput } : {}),
      })
      return withPipeHint({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })
    },

    async runProcess(request: ProcessRequest) {
      const activePolicy = await policy()
      if (activePolicy.mode === 'bypass' || !confineProcess) return inner.runProcess(request)
      const confined = await confine('process', request.argv, request, activePolicy)
      return inner.runProcess({ ...request, ...confined,
        ...(request.env || confined.env ? { env: { ...request.env, ...confined.env } } : {}),
      })
    },

    fetchHttp(request) {
      return inner.fetchHttp(request)
    },

    // A background process is confined exactly like a foreground one; with no
    // usable mechanism `confine` throws and nothing is started.
    ...(inner.startProcess
      ? {
          async startShell(request: BackgroundShellRequest) {
            const activePolicy = await policy()
            const open = activePolicy.mode === 'bypass' || request.unsandboxed === true
            if (open && inner.startShell) return inner.startShell(request)
            const confined = open
              ? { argv: shellArgv({ command: request.command, cwd: request.cwd }, config, false) }
              : await confine('shell', shellArgv({ command: request.command, cwd: request.cwd }, config), {}, activePolicy)
            return markSandboxed(await inner.startProcess!({ ...confined, cwd: request.cwd }), !open)
          },
          async startProcess(request: BackgroundProcessRequest) {
            const activePolicy = await policy()
            if (activePolicy.mode === 'bypass' || !confineProcess) return inner.startProcess!(request)
            const confined = await confine('process', request.argv, {}, activePolicy)
            return markSandboxed(await inner.startProcess!({ ...request, ...confined,
              ...(request.env || confined.env ? { env: { ...request.env, ...confined.env } } : {}),
            }), true)
          },
        }
      : {}),
  }
}

export type { ExecutionProvider } from '@tnega/execution'
