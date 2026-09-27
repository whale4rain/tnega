import { Service, type Context } from '@tnega/core'
import {
  normalizeError,
  notifyConfined,
  notifyError,
  preConfine,
  sandboxErrorCode,
} from './events.js'
import {
  SandboxError,
  isAbsolutePath,
  isConfinedMode,
  type ConfinedArgv,
  type SandboxBackendStatus,
  type SandboxConfineRequest,
  type SandboxOp,
  type SandboxExecutionPolicy,
  type SandboxPolicy,
} from './types.js'

export * from './types.js'
export * from './roots.js'
export * from './events.js'

declare module '@tnega/core' {
  interface Context {
    sandbox: SandboxService
  }
}

/** Provider 实现机制时收到的、已经完全显式的请求。 */
export interface SandboxMechanismRequest {
  op: SandboxOp
  argv: readonly string[]
  policy: SandboxPolicy
  signal?: AbortSignal
}

/**
 * 沙箱能力的 Service Definition：拥有 `ctx.sandbox` 与词汇，但不拥有任何机制。
 *
 * 一条缝的三个角色在这里的落点：
 *
 * ```
 * @tnega/sandbox-local (Provider) ─┐
 *                                  ├─→ @tnega/sandbox (ctx.sandbox)
 * @tnega/execution-sandbox (Consumer) ─┘
 * ```
 *
 * 契约：
 *
 * - **fail closed，绝不静默放行**：`confine` 要么交出一个真正受强制执行的 argv，
 *   要么抛错。宿主上没有可用后端时抛 {@link SandboxUnavailableError}，调用方必须
 *   放弃执行，而不是回退到非受限执行。
 * - **`bypass` 不是策略**：它表示「不要沙箱」，送进本服务即
 *   `SANDBOX_INVALID_POLICY`。绕过沙箱是调用方的显式选择，不该伪装成一次受限执行。
 * - **结果与拒绝分开**：Provider 如实报告 `enforcement` 与**本后端**的拒绝方言，
 *   调用方据此区分「被策略拒绝」与「runner 坏了」。
 * - **一次组合只挂一个 Provider**：同作用域注册第二个同名服务由 core 直接抛出。
 * - **事件面属于本包**：`confine` 是基类上的模板方法，`sandbox/*` 事件在基类统一
 *   派发；Provider 只实现 `runConfine`，因此自动参与全部事件，也不可能绕过它们。
 */
export abstract class SandboxService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sandbox')
  }

  /**
   * 真正把 argv 包装成受强制执行的 argv。只由基类的 `confine` 调用，Provider 不自行
   * 派发事件，也不做默认值解析 —— 收到的策略是完全显式的。
   */
  protected abstract runConfine(request: SandboxMechanismRequest): ConfinedArgv | Promise<ConfinedArgv>

  /**
   * 如实报告本 Provider 在当前宿主上的可用性与强制完整度。**不得抛**：探测失败就是
   * `available: false` 加 `detail`，由调用方决定怎么呈现。
   */
  abstract status(): Promise<SandboxBackendStatus>

  /**
   * 把一次准备执行的调用包进沙箱。
   *
   * 事件序列：`sandbox/pre-confine`（可收紧策略/改写 argv）→ Provider（`runConfine`）
   * → `sandbox/confined`；任一环节失败时改派 `sandbox/error` 并以原始失败拒绝。
   *
   * @throws SandboxUnavailableError 宿主上没有任何可用后端（`SANDBOX_UNAVAILABLE`）。
   * @throws SandboxError 策略或 argv 非法（`SANDBOX_INVALID_POLICY` /
   *   `SANDBOX_INVALID_ARGV` / `SANDBOX_INVALID_RESULT`）。
   */
  async confine(request: SandboxConfineRequest): Promise<ConfinedArgv> {
    const startedAt = Date.now()
    const policy = assertPolicy(request.policy)
    const argv = assertArgv(request.argv)
    let active: { op: SandboxOp; argv: readonly string[]; policy: SandboxPolicy } = {
      op: request.op,
      argv,
      policy,
    }
    try {
      const rewritten = await preConfine(this.ctx, { op: active.op, argv: active.argv, policy: active.policy })
      if (!isConfinedMode(rewritten.policy.mode)) {
        throw new SandboxError(
          'sandbox/pre-confine widened the policy to bypass; a listener may only narrow it',
          'SANDBOX_INVALID_POLICY',
        )
      }
      active = { op: rewritten.op, argv: rewritten.argv, policy: rewritten.policy }
      const confined = assertConfinedArgv(await this.runConfine({
        op: active.op,
        argv: active.argv,
        policy: active.policy,
        ...(request.signal ? { signal: request.signal } : {}),
      }))
      await notifyConfined(this.ctx, {
        op: active.op,
        argv: active.argv,
        confined: confined.argv,
        runner: confined.runner,
        policy: active.policy,
        enforcement: confined.enforcement,
        startedAt,
        durationMs: Date.now() - startedAt,
      })
      return confined
    } catch (error) {
      const failure = normalizeError(error)
      const code = sandboxErrorCode(failure)
      await notifyError(this.ctx, {
        op: active.op,
        policy: active.policy,
        error: failure,
        ...(code !== undefined ? { code } : {}),
        startedAt,
        durationMs: Date.now() - startedAt,
      })
      throw error
    }
  }
}

/** 策略必须是自洽的**受限**策略：`bypass` 与相对根都在这里被挡住。 */
function assertPolicy(policy: SandboxExecutionPolicy): SandboxPolicy {
  if (!isConfinedMode(policy.mode)) {
    throw new SandboxError(
      'bypass means "no sandbox"; do not confine it — call the execution boundary directly',
      'SANDBOX_INVALID_POLICY',
    )
  }
  if (!isAbsolutePath(policy.workspaceRoot)) {
    throw new SandboxError(
      `sandbox workspaceRoot must be an absolute path: ${JSON.stringify(policy.workspaceRoot)}`,
      'SANDBOX_INVALID_POLICY',
    )
  }
  return {
    mode: policy.mode,
    workspaceRoot: policy.workspaceRoot,
    ...(policy.tempRoot !== undefined ? { tempRoot: policy.tempRoot } : {}),
    ...(policy.sessionId !== undefined ? { sessionId: policy.sessionId } : {}),
  }
}

function assertArgv(argv: readonly string[]): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(entry => typeof entry === 'string')) {
    throw new SandboxError('argv must be a non-empty array of strings', 'SANDBOX_INVALID_ARGV')
  }
  if (argv[0] === undefined || argv[0].length === 0) {
    throw new SandboxError('argv must name an executable first', 'SANDBOX_INVALID_ARGV')
  }
  return [...argv]
}

function assertConfinedArgv(confined: ConfinedArgv): ConfinedArgv {
  if (!Array.isArray(confined.argv) || confined.argv.length === 0
    || !confined.argv.every(entry => typeof entry === 'string')) {
    throw new SandboxError(
      'provider returned a confined argv that is not a non-empty array of strings',
      'SANDBOX_INVALID_RESULT',
    )
  }
  if (typeof confined.runner !== 'string' || confined.runner.length === 0) {
    throw new SandboxError('provider returned no runner name', 'SANDBOX_INVALID_RESULT')
  }
  return confined
}

export default SandboxService

export const name = '@tnega/sandbox'
