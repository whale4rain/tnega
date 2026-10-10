/**
 * `@tnega/sandbox-windows-acl`：tnega 沙箱能力缝的 Windows 机制库。
 *
 * ## 机制
 *
 * 用受限令牌（`CreateRestrictedToken` + `WRITE_RESTRICTED`）把子进程的**写**权限收窄成
 * 一份白名单：令牌的 restricting SID 列表里放上 `logon SID + Everyone + workspace 能力
 * SID [+ temp 能力 SID]`，而这份白名单的另一半——指向这些能力 SID 的写 ACE——由本包
 * （Provider 侧）落在 workspace 树与私有 temp 目录的 DACL 上。内核的 write pass-2 检查
 * 只允许「restricting 列表 ∩ 对象 DACL」交集中的写权限，于是可写位置恰好等于被授予的
 * 树，别处一律 ERROR_ACCESS_DENIED。
 *
 * 写 ACE 的掩码见 `win32-abi.ts` 的 `GRANT_MASK`：写 + 删 + 删子项，但**排除**
 * WRITE_DAC / WRITE_OWNER —— 受限子进程不能改 DACL 或夺取所有权，否则白名单可以自举。
 *
 * ## 职责切分（这是与「进程内 AclSandbox」实现的关键区别）
 *
 * 本包只做**机制**，不做进程编排：
 *
 * - Provider（`@tnega/sandbox-local`）负责：规范化 workspace 路径 → 派生能力 SID
 *   （{@link workspaceWriteSid} / {@link tempWriteSid}）→ 用 {@link AclWriteGrant} 落
 *   ACE / 撤销 ACE → 用 {@link resolveRunnerCommand} 拼 runner argv。
 * - runner（`src/runner.ts`，通过 `./runner` 子路径导出、由 Node 直接执行）负责：在同一
 *   个进程里创建受限令牌、用继承的 stdio 启动目标命令、原样镜像退出码。
 *
 * 因此本包**没有**进程内 spawn API，也不依赖 `@tnega/sandbox`；模式类型自带为
 * {@link AclSandboxMode}，机制库与缝之间只共享字符串字面量。
 *
 * ## 本进程无需 Windows 也能加载
 *
 * koffi 只在 {@link isWindowsAclAvailable} 或第一次真正调用 ACL 时惰性解析，所以 SID
 * 派生、路径边界、runner argv 解析、runner 参数校验这些纯逻辑在任何平台都可以编译、
 * 加载并通过测试；依赖原生调用的断言只在 Windows 上执行。
 *
 * ## 限制
 *
 * 全部已知边界（Everyone 仍是环境写权限、NTFS 硬链接别名、只限写不限读/网络/进程可见性、
 * 目录必须属调用者、FAT 卷没有安全描述符、受限进程内用 libuv 命名管道 spawn 孙进程会
 * EPERM、CIM/WMI 不可用）写在包的 `README.md` 里。`enforcement` 因此永远是 `partial`，
 * Provider 不得报告 `full`。
 */

/** 本机制可以强制的两种模式。`bypass` 不是受限策略，不在机制库的词汇里。 */
export type AclSandboxMode = 'read-only' | 'workspace-write'

/**
 * runner 侧失败时的退出码。
 *
 * 上层（`@tnega/sandbox-local` / `@tnega/execution`）据此把「runner 没跑起来」与「命令
 * 自己失败了」分开：退出码 127 **且** stderr 出现 {@link RUNNER_FAILURE_PREFIX} 才说明
 * 命令根本没有以受限身份启动。退出码本身不足以证明失败（被包裹的命令恰好也可能退出
 * 127），所以两个条件都要看。
 */
export const RUNNER_FAILURE_EXIT_CODE = 127

/** runner 侧失败信息的前缀（`stderr` 的一行）。 */
export const RUNNER_FAILURE_PREFIX = 'windows-acl-run: '

/**
 * 本后端的「权限拒绝」方言：受限命令被 ACL 拒绝时 stderr 里会出现的**小写**子串。
 *
 * 按小写给出，匹配时做大小写不敏感的子串比较（英文 cmd 说 "Access is denied."，
 * 简体中文 cmd 说“拒绝访问”，pwsh/.NET 说
 * "Access to the path '...' is denied."，Node 说 "permission denied"）。不得把跨后端的
 * 并集当成本后端的方言，否则会把「runner 坏了」误判成「被策略拒绝」。
 */
export const DENIAL_SIGNATURES: readonly string[] = [
  'access is denied',
  '拒绝访问',
  'access to the path',
  'permission denied',
]

export { AclWriteGrant } from './grant.js'
export type { AclWriteGrantAddOptions, AclWriteGrantCreateOptions } from './grant.js'
export { isWindowsAclAvailable, Win32Error } from './ffi.js'
export { grantCommandArgs, parseGrantReply, resolveGrantCommand } from './grant-command.js'
export type { AclOperation, AclOperationRunner, GrantProcessResult, ResolveGrantCommandOptions } from './grant-command.js'
export { assertPrivateTempDisjoint, assertTempRootOutsideWorkspace } from './path-boundary.js'
export { resolveRunnerCommand } from './runner-command.js'
export type { ResolveRunnerCommandOptions } from './runner-command.js'
export { tempWriteSid, workspaceWriteSid } from './workspace-sid.js'
