/**
 * sandbox 能力的词汇：权限模式、策略、受限 argv 契约与稳定错误码。
 *
 * 这里只有类型与常量，没有 I/O，也没有任何具体机制的词汇 —— bwrap、landlock、
 * seatbelt、Windows ACL/受限令牌都属于 Provider（`@tnega/sandbox-local`）。
 */

/**
 * 一次 Agent Run 的文件权限预设，沿用 `CONTEXT.md` 的 Tool Permission 命名，
 * 因此 CLI / Web / Session 里已有的 `read-only` / `workspace-write` / `bypass`
 * 不需要任何映射。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'bypass'

/**
 * 可以由沙箱强制的模式。`bypass` 的含义是「不要沙箱」，它不是一个受限策略，
 * 因此 {@link SandboxService.confine} 拒绝它 —— 那是调用方自己绕开沙箱的信号，
 * 不应该伪装成一次受限执行。
 */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'bypass'>

/** 全部合法模式的运行期校验数组。 */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'bypass']

/** 未指定时的默认模式：fail-safe，需要显式 opt-in 才更宽。 */
export const DEFAULT_SANDBOX_MODE: SandboxMode = 'read-only'

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value)
}

export function isConfinedMode(mode: SandboxMode): mode is ConfinedSandboxMode {
  return mode !== 'bypass'
}

/**
 * Provider 如实报告的强制完整度。
 *
 * - `full`：该机制在它声明的维度上完全强制（例如 bwrap 的 mount profile）。
 * - `partial`：机制只在平台允许的范围内强制（例如旧 Landlock ABI、Windows ACL
 *   写白名单 —— 参见 `@tnega/sandbox-local` 的 README）。
 *
 * Provider 不得夸大：报 `full` 就意味着没有已知的绕过路径。
 */
export type SandboxEnforcement = 'full' | 'partial'

/**
 * 一次受限执行的文件效果。这是**全部**语义：网络与进程可见性不在词汇内，
 * 因为当前没有任何后端限制它们（这是已接受的限制，写在 README 里）。
 */
export interface SandboxExecutionPolicy {
  mode: SandboxMode
  /** 绝对路径；`workspace-write` 下可写的根。 */
  workspaceRoot: string
  /** 可选的私有临时目录，必须在 `workspaceRoot` 之外。 */
  tempRoot?: string
  /**
   * 可选的 Session 标识。Provider 用它把临时授权隔离到单次会话：同一个工作区的不同
   * 会话拿到各自的私有 temp 与 capability SID，一个会话结束后不留下另一个会话的状态。
   * 无 Session 的调用（评测、一次性任务）缺席即可。
   */
  sessionId?: string
}

/** 交给 Provider 的策略：模式已被收窄到可强制的两种之一。 */
export interface SandboxPolicy extends SandboxExecutionPolicy {
  mode: ConfinedSandboxMode
}

/** `resolveSandboxPolicy` 的输入：只有 `workspaceRoot` 是必需的。 */
export interface SandboxPolicyRequest {
  mode?: SandboxMode
  workspaceRoot: string
  tempRoot?: string
  sessionId?: string
}

/**
 * runner 失败的判定规则。
 *
 * **退出码本身永远不能证明 runner 失败**，所以规则是有序的三步：先按
 * `allowedExitCodes` 过滤（省略表示任意非零退出码都可匹配），再按整行精确相等剔除
 * `informationalLines`，最后对每行 stderr 做 `fatalSignatures` 大小写不敏感的子串匹配。
 */
export interface RunnerFailureRule {
  /** 允许的退出码；省略表示只看签名。 */
  allowedExitCodes?: readonly number[]
  /** 非空子串，逐 stderr 行匹配。 */
  fatalSignatures: readonly string[]
  /** 匹配前先按整行精确相等剔除的良性行。 */
  informationalLines?: readonly string[]
}

/**
 * Provider 交出的受限 argv。
 *
 * `argv` 已经包含 runner 与其 profile：`[runner, ...profile, '--', ...callerArgv]`。
 * 调用方直接 spawn 它即可，不需要知道 runner 是什么。
 */
export interface ConfinedArgv {
  argv: string[]
  /** runner 的可读名字，用于审计与诊断（例如 `bwrap` / `windows-acl`）。 */
  runner: string
  enforcement: SandboxEnforcement
  /**
   * **本后端**的拒绝方言（bwrap 的只读文件系统文案、Landlock 的 EACCES、
   * ACL 的 Access is denied……）。不得把跨后端的并集当成自己的方言，否则会把
   * 「runner 坏了」误判成「被策略拒绝」。
   */
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRule[]
}

/** 一次受限执行的请求。 */
export interface SandboxConfineRequest {
  /** 调用方准备做什么：模型可见的 `shell`，还是无 shell 的 argv 进程。 */
  op: SandboxOp
  /** 未包装的 argv。`shell` 由调用方自己决定形态（例如 `['/bin/sh', '-c', command]`）。 */
  argv: readonly string[]
  policy: SandboxExecutionPolicy
  signal?: AbortSignal
}

/** 调用方准备执行的东西的判别标签。 */
export type SandboxOp = 'shell' | 'process'

/** `status()` 的诊断结果：Provider 不得抛出，只如实报告。 */
export interface SandboxBackendStatus {
  available: boolean
  /** 选中的 runner 名字；不可用时缺席。 */
  runner?: string
  /** 选中 runner 的强制完整度；不可用时缺席。 */
  enforcement?: SandboxEnforcement
  /** 不可用或降级的原因，面向人类。 */
  detail?: string
}

/**
 * `sandbox/pre-confine` 的负载（waterfallAsync）：策略已解析、尚未调用机制。
 *
 * 监听器可以改写 `policy`（收紧模式、换根）或 `argv`（例如给命令加 `--dry-run`），
 * 但**不得放宽**：放宽模式是调用方的决定，不是监听器的。不调用 `next()` 交出事件即
 * 以 `SANDBOX_INVALID_POLICY` 失败，绝不静默跳过。
 */
export interface SandboxPreConfineEvent {
  op: SandboxOp
  argv: readonly string[]
  policy: SandboxPolicy
}

/**
 * `sandbox/confined` 的负载（parallel）：一次受限 argv 已经包装完成，即将被调用方
 * 执行。`argv` 是包装后的 argv，`policy` 是实际生效的策略（`sandbox/pre-confine`
 * 改写之后）。
 */
export interface SandboxConfinedEvent {
  op: SandboxOp
  /** 调用方原始的 argv。 */
  argv: readonly string[]
  /** Provider 交出的受限 argv。 */
  confined: readonly string[]
  runner: string
  policy: SandboxPolicy
  enforcement: SandboxEnforcement
  startedAt: number
  durationMs: number
}

/**
 * `sandbox/error` 的负载（parallel）：一次受限执行没有拿到可执行的 argv。
 * `code` 为 `SANDBOX_UNAVAILABLE` 时表示宿主缺后端，调用方必须放弃执行。
 */
export interface SandboxErrorEvent {
  op: SandboxOp
  policy: SandboxPolicy
  error: Error
  code?: SandboxErrorCode
  startedAt: number
  durationMs: number
}

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
      + 'the ACL restricted-token runner can start (Windows) — otherwise run with bypass.',
      'SANDBOX_UNAVAILABLE',
    )
    if (detail !== undefined) this.message += ` Runner failure: ${detail}`
  }
}

/**
 * 把请求解析成完全显式的策略：默认值唯一的落点。
 *
 * 与搜索缝同一个契约 —— `resolve*` 之外不得再出现 `?? 默认值`。
 * `workspaceRoot` 必须是绝对路径：相对路径的含义取决于进程 cwd，而沙箱边界不能
 * 随 cwd 漂移。
 */
export function resolveSandboxPolicy(request: SandboxPolicyRequest): SandboxExecutionPolicy {
  const mode = request.mode ?? DEFAULT_SANDBOX_MODE
  if (!isSandboxMode(mode)) {
    throw new SandboxError(
      `unknown sandbox mode: ${JSON.stringify(request.mode)}`,
      'SANDBOX_INVALID_POLICY',
    )
  }
  if (typeof request.workspaceRoot !== 'string' || !isAbsolutePath(request.workspaceRoot)) {
    throw new SandboxError(
      `sandbox policy workspaceRoot must be an absolute path: ${JSON.stringify(request.workspaceRoot)}`,
      'SANDBOX_INVALID_POLICY',
    )
  }
  return {
    mode,
    workspaceRoot: request.workspaceRoot,
    ...(request.tempRoot !== undefined ? { tempRoot: request.tempRoot } : {}),
    ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
  }
}

/** 平台无关的绝对路径判断：POSIX 的 `/` 与 Windows 的 `C:\` / UNC 都算。 */
export function isAbsolutePath(path: string): boolean {
  return /^([/\\]|[A-Za-z]:[/\\])/.test(path)
}
