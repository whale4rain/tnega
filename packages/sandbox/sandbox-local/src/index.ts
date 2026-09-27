import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@tnega/core'
import { containsDirectory } from '@tnega/fs-sandbox'
import {
  SandboxError,
  SandboxService,
  SandboxUnavailableError,
  canonicalPath,
  type ConfinedArgv,
  type ConfinedSandboxMode,
  type RunnerFailureRule,
  type SandboxBackendStatus,
  type SandboxEnforcement,
  type SandboxMechanismRequest,
  type SandboxPolicy,
} from '@tnega/sandbox'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from './profiles.js'

/** 本机可用的机制名。`custom` 是自带 runner 的逃生口（部署方提供实现）。 */
export type SandboxRunnerName = 'bwrap' | 'landlock' | 'seatbelt' | 'windows-acl' | 'custom'

/**
 * 平台 → 机制链。顺序就是优先级：链上第一个**功能性探测**通过的机制被选中。
 *
 * linux 选 bwrap 优先是因为它的 mount profile 与模式词汇最贴近（工作区可写 = 同路径
 * rw bind）；bwrap 不可用（例如 user namespace 被禁）时退到 landlock。
 */
const PLATFORM_CHAINS: Partial<Record<NodeJS.Platform, readonly SandboxRunnerName[]>> = {
  linux: ['bwrap', 'landlock'],
  darwin: ['seatbelt'],
  win32: ['windows-acl'],
}

/**
 * 机制声明的强制完整度。只有 Windows ACL 是 `partial`：它授予的是**写**白名单
 * （`WRITE_RESTRICTED` 只交叉检查写访问），Everyone 仍在环境权限里，NTFS 硬链接还是
 * 文件对象别名。详见 `@tnega/sandbox-windows-acl` 的 README。
 */
const STATIC_ENFORCEMENT: Record<SandboxRunnerName, SandboxEnforcement> = {
  bwrap: 'full',
  landlock: 'full',
  seatbelt: 'full',
  'windows-acl': 'partial',
  custom: 'full',
}

/** 各后端的**拒绝**方言。刻意不做并集：混在一起会把「runner 坏了」读成「被策略拒绝」。 */
const DENIAL_SIGNATURES: Record<SandboxRunnerName, readonly string[]> = {
  bwrap: ['read-only file system', 'Permission denied'],
  landlock: ['Permission denied'],
  seatbelt: ['Operation not permitted'],
  'windows-acl': ['Access is denied', 'access is denied', 'EPERM'],
  custom: [],
}

/** 各后端 runner **自己失败**时的签名（区别于被策略拒绝）。 */
const RUNNER_FAILURE_RULES: Record<SandboxRunnerName, readonly RunnerFailureRule[]> = {
  bwrap: [{ fatalSignatures: ['bwrap: '] }],
  landlock: [{ allowedExitCodes: [125], fatalSignatures: ['landlock-run: '] }],
  seatbelt: [{ fatalSignatures: ['sandbox-exec: '] }],
  'windows-acl': [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }],
  custom: [],
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000

/** Windows ACL 机制包的形状：只有 win32 才会被动态加载。 */
type WindowsAclModule = typeof import('@tnega/sandbox-windows-acl')

interface AclGrant {
  add(path: string, options?: { revocable?: boolean }): Promise<void>
  revoke(path: string): Promise<void>
  dispose(): Promise<void>
}

interface TempGrant {
  dir: string
  sid: string
  grant: AclGrant
}

/** 测试与部署方的注入点；生产路径不需要它。 */
export interface SandboxInternals {
  platform?: NodeJS.Platform
  chain?: readonly SandboxRunnerName[]
  /** 替换功能性探测；返回 `'unusable'` 表示该机制在本机不可用。 */
  probe?: (runner: SandboxRunnerName) => SandboxEnforcement | 'unusable'
}

export interface Config {
  /** 探测与无 Session 调用使用的根；默认 `process.cwd()`。 */
  workspaceRoot?: string
  /** 私有临时区的父目录；默认 `os.tmpdir()`。 */
  tempRoot?: string
  /** 探测单个机制的超时（毫秒），默认 5000。必须为正有限值。 */
  probeTimeoutMs?: number
  /** 覆盖机制链（顺序即优先级）；默认按平台。 */
  chain?: readonly SandboxRunnerName[]
  /** `custom` runner 的命令前缀。 */
  runnerCommand?: readonly string[]
  /** `custom` runner 的致命 stderr 签名（与 `runnerCommand` 同现同缺）。 */
  runnerFailureSignatures?: readonly string[]
  /** `custom` runner 的拒绝方言；默认空集，即只按失败规则判定。 */
  runnerDenialSignatures?: readonly string[]
  bwrapPath?: string
  landlockLauncher?: string
  sandboxExecPath?: string
  /** Windows ACL runner 的显式命令；默认由机制包自己解析。 */
  windowsAclRunnerCommand?: readonly string[]
  internals?: SandboxInternals
}

interface Selection {
  runner: SandboxRunnerName
  enforcement: SandboxEnforcement
}

let windowsAclModule: WindowsAclModule | undefined

/** 只在真正需要 Windows 机制时加载 koffi —— POSIX 上不该付这份代价。 */
async function windowsAcl(): Promise<WindowsAclModule> {
  windowsAclModule ??= await import('@tnega/sandbox-windows-acl')
  return windowsAclModule
}

/**
 * 本机沙箱 Provider：把 `argv` 包成某个真实机制的受限 argv。
 *
 * 契约与 `@tnega/sandbox` 的 Definition 一致，另外三条是本 Provider 自己的取舍：
 *
 * - **功能性探测，不是版本探测**：`bwrap --version` 能成功而 user namespace 被禁；
 *   所以探测真的跑一次受限 `true`。判决按 Provider 生命周期缓存，装卸 runner 需要
 *   重新挂载。
 * - **fail closed**：链上没有任何机制可用时抛 `SandboxUnavailableError`，绝不返回
 *   原始 argv。
 * - **副作用自己登记**：Windows 的 ACL 授权与私有临时目录在 `ctx.fiber.effect` 里
 *   登记清理；清理失败只记日志，不打断 teardown。
 */
export class LocalSandboxService extends SandboxService {
  private readonly config: Config
  private readonly platform: NodeJS.Platform
  private selection: Selection | undefined
  private probeFailure: string | undefined
  private readonly standingGrants = new Map<string, AclGrant>()
  private readonly tempGrants = new Map<string, TempGrant>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.config = config
    this.platform = config.internals?.platform ?? process.platform
    const probeTimeoutMs = config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) {
      // spawnSync 的 timeout: 0 在 Node 语义里是「无超时」，不能拿它当默认值。
      throw new TypeError('sandbox probeTimeoutMs must be a positive finite number')
    }
    if ((config.runnerCommand === undefined) !== (config.runnerFailureSignatures === undefined)) {
      throw new TypeError('runnerCommand and runnerFailureSignatures must be configured together')
    }
    if (config.runnerFailureSignatures?.some(signature => !signature.trim() || signature.includes('\n'))) {
      throw new TypeError('runnerFailureSignatures must be non-empty single-line strings')
    }
    ctx.fiber.effect(() => () => this.releaseGrants(), 'dispose sandbox grants')
  }

  override async status(): Promise<SandboxBackendStatus> {
    try {
      const selection = await this.select('read-only')
      return {
        available: true,
        runner: selection.runner,
        enforcement: selection.enforcement,
      }
    } catch (error) {
      return {
        available: false,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  protected override async runConfine(request: SandboxMechanismRequest): Promise<ConfinedArgv> {
    assertTempOutsideWorkspace(request.policy)
    const selection = await this.select(request.policy.mode)
    const runnerArgv = selection.runner === 'windows-acl'
      ? await this.confineWindowsAcl(request.policy, request.argv)
      : this.wrapArgv(selection.runner, request.policy, request.argv)

    return {
      argv: runnerArgv,
      runner: selection.runner,
      enforcement: selection.enforcement,
      denialSignatures: denialSignatures(selection.runner, this.config),
      runnerFailureRules: runnerFailureRules(selection.runner, this.config),
    }
  }

  /** POSIX 三个机制与 custom 都只是 argv 变换：机制自己声明 profile，不做别的。 */
  private wrapArgv(
    runner: SandboxRunnerName,
    policy: SandboxPolicy,
    argv: readonly string[],
  ): string[] {
    switch (runner) {
      case 'bwrap':
        return [this.config.bwrapPath ?? 'bwrap', ...bwrapProfileArgs(policy), '--', ...argv]
      case 'landlock':
        return [
          this.config.landlockLauncher ?? 'landlock-run',
          ...landlockProfileArgs(policy),
          '--',
          ...argv,
        ]
      case 'seatbelt':
        return [
          this.config.sandboxExecPath ?? 'sandbox-exec',
          ...seatbeltProfileArgs(policy),
          '--',
          ...argv,
        ]
      case 'custom':
        return [
          ...(this.config.runnerCommand ?? []),
          '--mode', policy.mode,
          '--workspace', policy.workspaceRoot,
          '--temp', this.tempBase(policy),
          '--',
          ...argv,
        ]
      case 'windows-acl':
        throw new SandboxUnavailableError(
          policy.mode,
          'windows-acl requires asynchronous grant preparation',
        )
    }
  }

  /**
   * Windows：受限令牌由 runner 自己从它的令牌派生，所以 Provider 这边要做的是把
   * **可写白名单**准备好 —— 给派生出来的 capability SID 授权。
   *
   * 生命周期取舍（与 `@tnega/sandbox-windows-acl` 的 README 一致）：
   *
   * - **workspace 的 standing ACE 常驻**，作为跨 Session 的复用缓存：撤销它会迫使下
   *   一次重新做整树传播，而它是一个只有本 Provider 会命名的随机 SID。
   * - **私有 temp 的 ACE 可撤销**，`dispose` 时撤销并删目录；每个 (session, workspace)
   *   一个，互不共享。
   */
  private async confineWindowsAcl(
    policy: SandboxPolicy,
    argv: readonly string[],
  ): Promise<string[]> {
    const acl = await windowsAcl()
    const workspaceRoot = canonicalPath(policy.workspaceRoot)
    const tempBase = this.tempBase(policy)
    acl.assertTempRootOutsideWorkspace(workspaceRoot, tempBase)

    const runnerCommand = this.config.windowsAclRunnerCommand ?? await acl.resolveRunnerCommand()
    const workspaceSid = acl.workspaceWriteSid(workspaceRoot)
    let tempDir = tempBase
    let tempSid: string | undefined

    if (policy.mode === 'workspace-write') {
      await this.ensureStandingGrant(acl, workspaceRoot, workspaceSid)
      const key = `${policy.sessionId ?? ''}\u0000${workspaceRoot}`
      const existing = this.tempGrants.get(key)
      if (existing) {
        tempDir = existing.dir
        tempSid = existing.sid
      } else {
        const created = await mkdtemp(join(tempBase, 'tnega-sbx-'))
        const dir = canonicalPath(created)
        const sid = acl.tempWriteSid(dir)
        // 只跟**实际会被授予**的目录比：Windows 上环境临时根（`os.tmpdir()`）永不隐式
        // 授权，而私有 temp 恰恰建在它下面 —— 拿 `writableRoots`（含 tmpdir）来比会把
        // 每一次 workspace-write 都判成冲突。
        acl.assertPrivateTempDisjoint(dir, [workspaceRoot])
        const grant = await acl.AclWriteGrant.create(sid)
        try {
          await grant.add(dir, { revocable: true })
        } catch (error) {
          await grant.dispose().catch(() => undefined)
          await rm(dir, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
        this.tempGrants.set(key, { dir, sid, grant })
        tempDir = dir
        tempSid = sid
      }
    }

    return [
      ...runnerCommand,
      '--workspace', workspaceRoot,
      '--temp', tempDir,
      '--mode', policy.mode,
      ...(tempSid === undefined ? [] : ['--write-sid', workspaceSid, '--temp-write-sid', tempSid]),
      '--',
      ...argv,
    ]
  }

  private async ensureStandingGrant(
    acl: WindowsAclModule,
    workspaceRoot: string,
    workspaceSid: string,
  ): Promise<void> {
    if (this.standingGrants.has(workspaceRoot)) return
    const grant = await acl.AclWriteGrant.create(workspaceSid)
    await grant.add(workspaceRoot, { revocable: false })
    this.standingGrants.set(workspaceRoot, grant)
  }

  private tempBase(policy: SandboxPolicy): string {
    return canonicalPath(policy.tempRoot ?? this.config.tempRoot ?? tmpdir())
  }

  /**
   * 选中机制：链上第一个功能性探测通过的。
   *
   * 探测判决（含「不可用」）按 Provider 生命周期缓存 —— 探测要起进程，而机制不会在
   * 一次运行中间出现或消失。
   */
  private async select(mode: ConfinedSandboxMode): Promise<Selection> {
    if (this.selection !== undefined) return this.selection
    const chain = this.config.internals?.chain ?? this.config.chain
      ?? PLATFORM_CHAINS[this.platform] ?? []
    const failures: string[] = []
    for (const runner of chain) {
      const probed = await this.probeRunner(runner)
      if (probed !== 'unusable') {
        this.selection = { runner, enforcement: probed }
        return this.selection
      }
      failures.push(`${runner}: ${this.probeFailure ?? 'probe failed'}`)
    }
    const detail = failures.length > 0
      ? failures.join('; ')
      : `no sandbox mechanism is configured for platform "${this.platform}"`
    throw new SandboxUnavailableError(mode, detail)
  }

  private async probeRunner(runner: SandboxRunnerName): Promise<SandboxEnforcement | 'unusable'> {
    this.probeFailure = undefined
    const override = this.config.internals?.probe
    if (override !== undefined) {
      const verdict = override(runner)
      if (verdict === 'unusable') this.probeFailure = 'injected probe'
      return verdict
    }
    const timeout = this.config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    switch (runner) {
      case 'bwrap':
        return this.probeCommand(
          this.config.bwrapPath ?? 'bwrap',
          [...bwrapProfileArgs(this.probePolicy()), '--', 'true'],
          timeout,
          STATIC_ENFORCEMENT.bwrap,
        )
      case 'seatbelt':
        return this.probeCommand(
          this.config.sandboxExecPath ?? 'sandbox-exec',
          [...seatbeltProfileArgs(this.probePolicy()), '--', 'true'],
          timeout,
          STATIC_ENFORCEMENT.seatbelt,
        )
      case 'landlock': {
        const result = spawnSync(this.config.landlockLauncher ?? 'landlock-run', ['--probe'], {
          timeout,
          encoding: 'utf8',
          windowsHide: true,
        })
        if (result.status !== 0) {
          this.probeFailure = probeDetail(result)
          return 'unusable'
        }
        // launcher 自己报告协商到的 ABI：宁可如实说 partial，也不夸大。
        return (result.stdout ?? '').includes('partially enforced') ? 'partial' : 'full'
      }
      case 'windows-acl':
        return this.probeWindowsAcl(timeout)
      case 'custom':
        if (this.config.runnerCommand === undefined || this.config.runnerCommand.length === 0) {
          this.probeFailure = 'runnerCommand is not configured'
          return 'unusable'
        }
        return STATIC_ENFORCEMENT.custom
    }
  }

  private async probeWindowsAcl(timeout: number): Promise<SandboxEnforcement | 'unusable'> {
    const acl = await windowsAcl().catch((error: unknown) => {
      this.probeFailure = error instanceof Error ? error.message : String(error)
      return undefined
    })
    if (acl === undefined) return 'unusable'
    if (!(await acl.isWindowsAclAvailable())) {
      this.probeFailure = 'koffi (FFI) is not available'
      return 'unusable'
    }
    const runnerCommand = this.config.windowsAclRunnerCommand ?? await acl.resolveRunnerCommand()
    const [command, ...prefix] = runnerCommand
    if (command === undefined) {
      this.probeFailure = 'windows-acl runner command is empty'
      return 'unusable'
    }
    return this.probeCommand(
      command,
      [
        ...prefix,
        '--workspace', this.probePolicy().workspaceRoot,
        '--temp', tmpdir(),
        '--mode', 'read-only',
        '--', 'cmd.exe', '/d', '/s', '/c', 'exit 0',
      ],
      timeout,
      STATIC_ENFORCEMENT['windows-acl'],
    )
  }

  private probeCommand(
    command: string,
    args: readonly string[],
    timeout: number,
    enforcement: SandboxEnforcement,
  ): SandboxEnforcement | 'unusable' {
    const result = spawnSync(command, [...args], { timeout, stdio: 'ignore', windowsHide: true })
    if (result.status === 0) return enforcement
    this.probeFailure = probeDetail(result)
    return 'unusable'
  }

  /** 探测用的中性策略：只读不需要绑定任何可写根，所以用 cwd 即可。 */
  private probePolicy(): SandboxPolicy {
    return {
      mode: 'read-only',
      workspaceRoot: canonicalPath(this.config.workspaceRoot ?? process.cwd()),
    }
  }

  /**
   * teardown：撤销可撤销的 temp 授权并删除私有临时目录，释放 SID。
   *
   * 失败只记日志、不抛 —— cordis 的 teardown 不该被授权清理打断；常驻 workspace ACE
   * 是预期终态，不是残留。
   */
  private async releaseGrants(): Promise<void> {
    const failures: unknown[] = []
    for (const entry of this.tempGrants.values()) {
      await entry.grant.revoke(entry.dir).catch((error: unknown) => failures.push(error))
      await entry.grant.dispose().catch((error: unknown) => failures.push(error))
      await rm(entry.dir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    this.tempGrants.clear()
    for (const grant of this.standingGrants.values()) {
      await grant.dispose().catch((error: unknown) => failures.push(error))
    }
    this.standingGrants.clear()
    if (failures.length > 0) {
      this.ctx.logger('sandbox-local').warn('sandbox grant cleanup failed', failures)
    }
  }
}

/**
 * 私有临时区不能落在工作区之内：那样它会被当成「工作区内的路径」，从而把「临时写」
 * 与「工作区写」混成一件事 —— Windows 上还会让 temp ACE 直接放大工作区的可写面。
 */
function assertTempOutsideWorkspace(policy: SandboxPolicy): void {
  if (policy.tempRoot === undefined) return
  if (containsDirectory(policy.workspaceRoot, policy.tempRoot)) {
    throw new SandboxError(
      `sandbox tempRoot must live outside the workspace: ${policy.tempRoot}`,
      'SANDBOX_INVALID_POLICY',
    )
  }
}

function probeDetail(result: { status: number | null; error?: Error | undefined; signal?: NodeJS.Signals | null }): string {  if (result.error !== undefined) return result.error.message
  if (result.signal != null) return `killed by ${result.signal}`
  return `exit code ${String(result.status)}`
}

function denialSignatures(runner: SandboxRunnerName, config: Config): readonly string[] {
  if (runner === 'custom' && config.runnerDenialSignatures !== undefined) {
    return config.runnerDenialSignatures
  }
  return DENIAL_SIGNATURES[runner]
}

function runnerFailureRules(runner: SandboxRunnerName, config: Config): readonly RunnerFailureRule[] {
  if (runner === 'custom') {
    const signatures = config.runnerFailureSignatures
    if (signatures === undefined || signatures.length === 0) return []
    return [{ fatalSignatures: signatures }]
  }
  return RUNNER_FAILURE_RULES[runner]
}

export const name = '@tnega/sandbox-local'

/** 挂载入口：`await ctx.plugin(sandboxLocal, { workspaceRoot: cwd })`。 */
export const sandboxLocal = {
  name: 'sandbox-local',
  apply(ctx: Context, config: Config = {}) {
    new LocalSandboxService(ctx, config)
  },
}
