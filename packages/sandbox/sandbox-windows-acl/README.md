# `@tnega/sandbox-windows-acl`

tnega 沙箱能力缝的 Windows 机制库：用受限令牌 + 能力 SID 写白名单，把受限子进程的**写**
权限收窄到 workspace 与一个私有 temp 目录。

## 机制

Windows 的访问检查在写访问上做两遍：一遍用令牌的普通 SID，一遍用 `WRITE_RESTRICTED`
令牌的 **restricting SID**。两遍都通过才允许写。本包做的就是这件事的两半：

1. **白名单的一半**（本包，Provider 调用）：为每个 workspace 与每个私有 temp 目录派生一个
   确定性的能力 SID（`S-1-4-x-y`），把它作为一条可继承的写 ACE 落到目录的 DACL 上。
2. **令牌的一半**（runner 进程内）：把调用者的令牌复制成 `WRITE_RESTRICTED` 令牌，restricting
   列表里放 `logon SID + Everyone + workspace 能力 SID [+ temp 能力 SID]`。

写 ACE 的掩码是写 + 删 + 删子项（显示为 Modify），但**排除** `WRITE_DAC` 与 `WRITE_OWNER`：
受限子进程不能改 DACL 或夺取所有权——否则它可以直接把自己加回白名单，白名单就不再是边界。

两处身份刻意不同：

- `workspaceWriteSid(root)`：`sha256(规范化路径)` 的前两个 u32 → 每个 workspace 每台机器
  只落一次 ACE，之后每次供给都命中「完全一致 ACE」跳过（大仓库重新传播一次要几分钟）。
- `tempWriteSid(dir)`：`sha256('temp\0' + dir)` 加固定的第三子授权号 `1` → 同一 workspace 上
  的兄弟 session 共享 workspace 权限，但进不了彼此的 temp 树。

## 职责切分

这是与「进程内 `AclSandbox`」实现的关键区别：本包只做机制，不做进程编排。

| 角色 | 位置 | 负责 |
|---|---|---|
| Service Definition | `@tnega/sandbox` | 词汇与 `ctx.sandbox`，不含任何机制 |
| Provider | `@tnega/sandbox-local` | 规范化路径 → 派生 SID → 授予/撤销 ACE → 拼 runner argv |
| runner | 本包 `./runner` | 创建受限令牌、启动目标命令、镜像退出码 |

因此本包**没有进程内 spawn API**，也不依赖 `@tnega/sandbox`（模式类型自带为
`AclSandboxMode`）。受限令牌必须在真正启动子进程的那个进程里创建，所以令牌层的代码物理上
就在 runner 里。

## runner 契约

Provider 拼出来的 argv：

```text
[node, <runner>, --workspace <绝对目录> --temp <绝对目录> --mode <read-only|workspace-write>
       [--write-sid <S-1-4-x-y> --temp-write-sid <S-1-4-x-y-1>] -- <argv...>]
```

- `--workspace` / `--temp` 必给，且必须是**已存在的绝对目录**（相对路径的含义取决于 runner 的
  cwd，边界不能随 cwd 漂移）。
- `read-only` 不接受任何 SID 参数；`workspace-write` 两个 SID 必须同现。
- runner 会重新派生 `workspaceWriteSid(--workspace)` / `tempWriteSid(--temp)` 并与传入值比对，
  还会拒绝落在 workspace 之内的 `--temp`。
- 模式降级（`workspace-write` → `read-only`）或崩溃续跑留下的常驻 ACE 在 `read-only` 下是
  **惰性**的：restricting 列表里没有能力 SID，pass-2 只认列表里有的东西。

runner 用**继承的 stdio**（`GetStdHandle` → 临时打开 `HANDLE_FLAG_INHERIT` →
`STARTF_USESTDHANDLES` + `bInheritHandles=1`），不实现匿名管道轮询：stdin、输出上限、超时与
取消都属于 `@tnega/execution` 层。`lpEnvironment = NULL` 让子进程继承 runner 自己的环境块
（koffi 传显式环境块会让 `CreateProcessAsUserW` 以 `ERROR_INVALID_PARAMETER` 失败），因此
`workspace-write` 下 runner 会先把**自己进程**的 `TMP`/`TEMP` 指向 `--temp`（`read-only` 保持
原样）——不改的话，命令在工作区之外的临时写会因为 ACL 而失败得很奇怪。子进程以
`CREATE_SUSPENDED` 创建、放进 `KILL_ON_JOB_CLOSE` 的 Job、再 `ResumeThread`，等待结束后原样
镜像 32 位退出码。

任何 runner 侧失败（参数、校验、令牌、spawn）都会在 stderr 写一行 `windows-acl-run: <detail>`
并以 **127** 退出，绝不以非受限方式启动目标命令。上层据此区分「runner 没跑起来」与「命令自己
失败了」，判据是退出码 127 **且**出现该前缀（退出码本身不足以证明，被包裹的命令也可能是 127）。

## 为什么 runner 自包含

Node 22 的类型剥离按原样解析 import 说明符：`./acl.js` **不会**映射到 `./acl.ts`。所以
`src/runner.ts` 里没有任何相对 import —— 它只依赖 `node:*`，并且只在参数校验**通过之后**才
惰性 `await import('koffi')`。

好处有两层：

- 把 `runner.ts` 复制到别处、直接 `node runner.ts` 就能跑（测试就是这么做的）；
- 参数校验、SID 派生、路径边界这些纯逻辑在没有安装 koffi（或非 Windows）的宿主上照样能编译、
  加载并通过测试——koffi 从不参与模块求值。

代价是令牌层在 runner 里保留了一份与包内 ACL 层同形状的 `RunnerBindings`；两侧公共成员的
签名由测试里的同一张假绑定表在编译期钉住，SID 派生算法的一致性由 `deriveWorkspaceWriteSid` /
`deriveTempWriteSid` 与包导出的同名函数的对拍钉住。

## 公共 API

```ts
type AclSandboxMode = 'read-only' | 'workspace-write'

const RUNNER_FAILURE_EXIT_CODE = 127
const RUNNER_FAILURE_PREFIX = 'windows-acl-run: '
const DENIAL_SIGNATURES: readonly string[] // 本后端的拒绝方言（小写，大小写不敏感匹配）

function workspaceWriteSid(workspaceRoot: string): string // S-1-4-x-y
function tempWriteSid(tempDir: string): string // S-1-4-x-y-1

class AclWriteGrant {
  readonly writeSid: string
  static create(writeSid: string, options?: { operate?: AclOperationRunner }): Promise<AclWriteGrant>
  add(path: string, options?: { revocable?: boolean }): Promise<void>
  revoke(path: string): Promise<void>
  dispose(): Promise<void> // 撤销 revocable 路径 + 释放 SID；常驻路径保留
  get paths(): readonly string[]
}

function assertTempRootOutsideWorkspace(workspaceRoot: string, tempRoot: string): void
function assertPrivateTempDisjoint(tempDir: string, writableDirs: readonly string[]): void
function resolveRunnerCommand(options?: {
  runnerCommand?: readonly string[]
  moduleUrl?: string | URL // 仅测试用：解析锚点，默认 import.meta.url
}): readonly string[]
function resolveGrantCommand(options?: { moduleUrl?: string | URL }): readonly string[] | undefined
function grantCommandArgs(operation: AclOperation): string[]
function parseGrantReply(result: GrantProcessResult, operation: AclOperation): boolean
function isWindowsAclAvailable(): Promise<boolean> // 探测用，不抛
class Win32Error extends Error { readonly api: string; readonly win32Code: number }
```

每个 Win32 调用失败都会抛出带 API 名与精确错误码的 `Win32Error`（例如
`SetNamedSecurityInfoW failed (Win32 1307): grantWrite(C:\...)`），没有静默降级。

`resolveRunnerCommand()` 只按**本模块自己的位置**解析，不引用调用方的目录：显式
`runnerCommand` 优先；否则看与本模块同目录的 `sandbox-windows-acl-runner.js`（发布形态：根包打出
`dist/sandbox-windows-acl.js` 与 `dist/sandbox-windows-acl-runner.js` 两个同目录文件）；否则看同
目录的 `runner.ts`（仓库内 dev/vitest 形态）；都不存在就抛出并列出尝试过的路径。解析失败**不**会
静默返回空数组——拿不到 runner 就是拿不到受限执行。

## 生命周期：workspace 常驻，temp 可撤销

ACE 是**真实目录上的持久变更**，不是进程内的开关，所以两个能力的生命周期刻意不同：

- **workspace ACE 常驻**：它就是跨 session、跨进程重启的复用缓存，`dispose()` 不撤销它。
  撤销会让下一次供给重新传播整棵树。workspace 目录改名会派生新 SID，旧 ACE 成为无害残留。
- **temp ACE 可撤销**：继承性 ACE 不能活得比它所属 session 的 temp 目录更久，`dispose()` 撤销
  它（`add(path, { revocable: true })`），`revoke(path)` 也可以显式撤销。一次撤销只删该受托者
  的 ACE，别人的显式 ACE 原样保留。

授予是「读当前 DACL → 合并 → 写回」，整段跑在每路径独占的 `LockFileEx` 锁下，因此并发的
Provider 实例不会互相覆盖 ACE；命中完全一致的 ACE 时跳过 `SetNamedSecurityInfoW`（大树上这是
「重新传播整棵树」与「读一次 DACL」的差别）。等锁有上限：以 `LOCKFILE_FAIL_IMMEDIATELY` 轮询，
默认 5 分钟后以 `LockFileEx` 错误失败（fail closed），持有者挂住时不会把调用线程永远阻塞。

## 授予在 helper 进程里执行

首次授予时 `SetNamedSecurityInfoW` 要把可继承 ACE 同步传播到整棵 workspace 树，大仓库上能跑
几十分钟。桌面端把 Agent Runtime 跑在 Electron 主进程里，在进程内做这件事会让窗口「未响应」。
所以 `AclWriteGrant.create(sid, { operate })` 接受一个执行者，Provider 用它把每一次授予/撤销交给
一次性的 helper 进程：

```text
[node, <sandbox-windows-acl-grant.js>, <grant|revoke>, <目录>, <能力 SID>]
```

helper（`src/grant-entry.ts`）在 stdout 写一行 JSON 回传，成功退出 0、失败退出 1；
`parseGrantReply` 把失败还原成 `Win32Error`，没有回传的退出一律抛出。helper 只有发布形态
（根包 `dist/`、桌面端 `out/`，都与包入口同目录）；仓库内 dev/vitest 形态
`resolveGrantCommand()` 返回 `undefined`，授予退回进程内执行。Provider 不给 helper 设超时：
中途杀掉会留下一棵只传播了一半的树。

## 限制

这些是机制本身的性质，不是实现缺陷；Provider 因此永远只能报告 `partial` 强制完整度。

- **Everyone 仍是环境写权限**：`Everyone` 必须留在 restricting 列表里（移除会让早期 DLL 初始化
  以 `0xC0000142` 崩溃、CNG/pwsh 崩），所以任何显式给 Everyone 写权限的外部对象在这两种模式下
  都仍然可写。`INTERACTIVE`/`LOCAL` 不在列表里（Public 树给 INTERACTIVE 写权限），
  `Authenticated Users` 也不在。
- **NTFS 硬链接是文件对象别名，不是路径别名**：workspace ACE 会传播到已有的硬链接上，于是同一个
  文件对象通过外部别名也可写。拒绝多链接文件对普通 pnpm 安装不可行。
- **只限写，不限读、网络与进程可见性**：`WRITE_RESTRICTED` 只交叉写访问。受限子进程可以读
  调用者能读的任何文件、可以开 socket。`read-only` 需要读侧策略才算表达完整。
- **目录必须属于调用者**：所有者隐含的 `WRITE_DAC` 是能在不提权的前提下改 DACL 的原因。
- **FAT 卷没有安全描述符**：把 FAT 卷作为授予根会大声失败；授予根**之外**的 FAT 目标没有安全
  描述符，两种模式下都保持可写（FAT 视为历史残留）。
- **受限进程内用 libuv 命名管道 spawn 孙进程会 EPERM**：`spawn(..., { stdio: 'pipe' })` 的客户端
  打开请求写的权限没有任何 restricting SID 被授予（Win32 层的默认 SD 模板，不是令牌默认 DACL）。
  继承与忽略 stdio 的 spawn 正常；匿名管道（PowerShell 管道）正常，因为受限令牌的默认 DACL 里
  有一条指向 restricting SID 的全权 ACE（`setTokenDefaultDaclGrant` 合并的那条）。
  修不了：能让 pass-2 通过的只有管道 owner（当前用户 SID），把它放进 restricting 列表等于
  撤掉写围栏（Codex 只在专用沙箱账户的 elevated 模式下这样做）。影响面很大——`npm run dev`、
  vite / esbuild、多数测试运行器都会这样启动子进程——所以出路在上层：`execution-sandbox`
  识别这类失败并在 stderr 里提示，`shell`（前台或经 `job_start` 后台运行）带 `escalate: true` 与理由重试，
  经批准后在沙箱外运行（`ShellRequest.unsandboxed`）。
  调研与方案比较（Codex elevated 专用沙箱用户、DSH 按命令提权）见
  [docs/research/2026-10-04-windows-sandbox-named-pipes.md](../../../docs/research/2026-10-04-windows-sandbox-named-pipes.md)。
- **CIM/WMI 不可用**：`Authenticated Users` 缺席使 WMI 命名空间安全检查失败（`0x80041003`），
  因此两种模式下的 `Get-CimInstance` / `Get-ComputerInfo` 都不可用。这是关掉 `C:\` 根树创建逃逸
  的另一面。
- **控制台隔离不可用**：`CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 创建的子进程在 DLL 初始化阶段
  以 `STATUS_DLL_INIT_FAILED` 死亡；子进程共享宿主控制台，管道形式的 stdio 重定向不受影响。
- **授予是即时的整树传播**：带继承 ACE 的目录上调用 `SetNamedSecurityInfoW` 会立刻走到每个后代；
  每 workspace 一次，之后的供给靠完全一致 ACE 跳过变便宜。
- **清理是尽力而为**：`dispose()` 会尝试每一次 temp 撤销并把失败聚合成 `AggregateError`；清理
  失败可能留下随机目录与只指向 temp SID 的 ACE，之后没有任何令牌携带该 SID，因此是无害残留。
- **一个 workspace 一份写白名单**：写 SID 就是 workspace 身份；用同一个实例服务两个 workspace
  会把两份授予都放宽。每 workspace 一个实例。
- **交给 `cmd.exe` 的命令按原样传递，不做 CRT 转义**：`cmd.exe` 不按 CommandLineToArgvW 规则解析
  `/c`、`/k` 之后的文本，因此 runner 遇到 cmd 时只把「程序名 + `/c` 之前的开关」按 CRT 规则加引号，
  命令部分**逐字**包进一对引号，交给 cmd 的 `/s` 语义剥掉外层引号后自行解析（Node 的
  `shell: true` 也是这么构造的）。这是有意为之：对 cmd 做 CRT 转义会让 `\"` 原样留在命令里、重定向
  符被引号包住而失效（`echo x> f` 什么都不写）。cmd 之外的可执行文件（bash/pwsh/node/rg…）保持完整
  的 CRT 规则。
- **NULL DACL 目录在授予+撤销后不是幂等的**：NULL DACL 意味着「所有人完全控制」，授予会从
  null 构造新 ACL，撤销往返后留下空（全拒）DACL 而非原来的 NULL DACL。真实的 workspace/temp
  目录都有真实 DACL，这是边界情况。

## 验证

```sh
pnpm typecheck                                              # 整仓
pnpm exec vitest run packages/sandbox/sandbox-windows-acl    # 纯逻辑在任何平台；ACL/E2E 仅 Windows 且需要 koffi
pnpm exec eslint packages/sandbox/sandbox-windows-acl
```

ACL 与端到端用例在 `process.platform === 'win32'` 且 `isWindowsAclAvailable()` 为真时才运行；
「workspace 之外不可写」这类断言还会先探测目标目录是否给 `Everyone` 写了权限（README 的第一条
限制——它必须留在 restricting 列表里，所以它的写 ACE 仍然算数），命中就带原因跳过，避免把环境
边界误当成实现缺陷。
