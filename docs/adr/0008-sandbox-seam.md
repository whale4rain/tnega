# 沙箱缝：把「受限执行」拆成 Service Definition / Service Provider / Consumer

> 状态：当前
> 取代关系：无
> 当前实现：`packages/sandbox/sandbox/README.md`、`packages/sandbox/sandbox-local/README.md`、`packages/sandbox/sandbox-windows-mxc/README.md`、`packages/sandbox/execution-sandbox/README.md`、`packages/sandbox/fs-sandbox/README.md`、`packages/sandbox/sandbox-windows-acl/README.md`
> 参考：DeepSeek Harness 的 `packages/sandbox/*`（`sandbox` / `sandbox-local` / `sandbox-windows-acl`）、`packages/fs/fs-sandbox`、`packages/shell/*-sandbox`

## 背景

在本次改动之前，Tnega 的「沙箱」只有三层进程内策略：路径围栏（`resolveInside`）、
工具注册开关（`allowShell` / `allowNetwork`）、逐次人工批准（`ToolGuard` +
`ApprovalBroker`）。Shell 走的是 `spawn(command, { shell: true })`：命令本身**完全不受
限制**，`cwd` 是唯一被围栏约束的东西。`docs/research/coding-harness-opportunities-2026-09.md`
把这一点记为已知差距：「Tnega 的 Shell 当前没有 OS sandbox」。

同时，`packages/tools/src/path.ts` 的 `resolveInside` 是「什么算工作区之内」的唯一定义，
而它只做词法比较加一层最深已存在祖先的 `realpath`：在 Windows 上会漏掉 8.3 短名与大小写
别名。参考实现在 `fs-sandbox` 里用 `dev` + `ino` 身份回退解决了这一点。

## 决策

按 ADR 0006 的三角色定义落地一条新的能力缝：

```
@tnega/sandbox-local (Provider) ─┐
                                 ├─→ @tnega/sandbox (ctx.sandbox)
@tnega/execution-sandbox (Consumer) ─┘        @tnega/fs-sandbox（路径围栏，纯库）
```

- **Service Definition `@tnega/sandbox`**：拥有 `ctx.sandbox` 与全部词汇
  （`SandboxMode` / `SandboxExecutionPolicy` / `SandboxPolicy` / `ConfinedArgv` /
  `RunnerFailureRule` / `SandboxEnforcement`）、稳定错误码（`SANDBOX_*`）、默认值落点
  （`resolveSandboxPolicy`）、共享的根推导（`canonicalPath` / `writableRoots`）与事件面
  （`sandbox/pre-confine`、`sandbox/confined`、`sandbox/error`）。抽象面只有两件事：
  `runConfine`（机制）与 `status`（诊断）。
- **Service Provider `@tnega/sandbox-local`**：平台链 + **功能性探测** + profile 构造 +
  Windows 的 ACL 授权生命周期。链上第一个探测通过的机制胜出；链耗尽就抛
  `SandboxUnavailableError`。机制实现细节（bwrap / landlock / seatbelt / Windows ACL）
  不进入 Definition，也不进入 Consumer。
- **Service Provider `@tnega/sandbox-windows-acl`**：Windows 机制的实现库（受限令牌 +
  capability SID 写白名单 + 自包含 runner）。它是机制库而不是缝的角色：Provider 只
  按需 `import()` 它。
- **Consumer `@tnega/execution-sandbox`**：一个 `ExecutionProvider` 装饰器。它只 import
  Service Definition，把 `runShell` 的命令装成显式 argv（POSIX 是 `/bin/sh -c`，
  Windows 是 `cmd /d /s /c`），交给 `ctx.sandbox.confine`，再用无 shell 的 `runProcess`
  落进程。它不 import、不枚举任何具体 Provider。
- **`@tnega/fs-sandbox`**：fs 侧路径围栏的**唯一实现**（词法 + 身份包含判定、
  `resolveInside`、`assertWritablePath`）。`packages/tools/src/path.ts` 退化成转发，
  因此「什么算工作区之内」在整个仓库只有一份。

### 模式词汇沿用 CONTEXT，不引入第二套

`SandboxMode = 'read-only' | 'workspace-write' | 'bypass'`，与 `CONTEXT.md` 的 Tool
Permission 完全同名；Session 的 `permission/mode` 事件直接提供模式。`bypass` 在
Definition 里不是「更宽的策略」而是「不要沙箱」：`confine` 直接以
`SANDBOX_INVALID_POLICY` 拒绝它，调用方必须显式绕开沙箱，而不是让一次「受限执行」悄悄
不受限。

### 与本仓库既有能力缝的两处有意差异

1. **事件面由 Definition 拥有，但形态更小**。参考实现的 sandbox Definition 没有任何
   事件；本仓库的 ADR 0006 把「事件面属于 Service Definition，Provider 自动参与且无法
   绕过」写成不变量，所以保留了 `sandbox/pre-confine`（waterfall，只允许收紧）、
   `sandbox/confined` / `sandbox/error`（parallel 只读观察）。语义与 `search/*` 一致：
   观察者失败不改写权威结论，拒绝与结果分开。
2. **`confine` 是 async**。Windows 机制需要先做 ACL 授权（IO + FFI）才能交出 argv；把
   `confine` 定成同步会迫使 Provider 在构造期做副作用，那是更差的取舍。

## 后果

- **默认挂载，fail closed**。`createAgentRuntime`（CLI）、Web server 的两条 run 路径、
  `ProjectHost`、`createCodingEvalRuntime` 都挂 `sandbox-local`，并把
  `sandboxedExecution(...)` 交给 `builtinTools.execution`。因此 shell 在默认路径上真的
  被限制；宿主上没有任何可用机制时，shell 返回 `SANDBOX_UNAVAILABLE` 而不是偷偷以非
  受限方式执行。想恢复旧行为必须显式选 `bypass`。
- **只沙箱 shell，不沙箱 argv 进程**（`confineProcess` 默认 `false`）。理由与参考实现
  一致：`runProcess` 目前唯一的消费者是我们自己构造 argv 的搜索 Provider（ripgrep），
  把它也包进沙箱会给每次搜索加一层进程，而它本来只读。需要更严的部署可以打开这个开关。
- **网络不在词汇内**（已由下文「命令网络」补充取代）。当时没有任何后端限制网络，所以
  `SandboxMode` 只声明文件效果。`fetchHttp` 至今直接透传：它是宿主自己的 HTTP 工具，由
  `@tnega/execution` 的私网守卫与 allowed hosts 管。
- **`bypass` 与 `allowOutsideWorkspace` 仍各自存在**：`allowOutsideWorkspace` 控制
  `@tnega/tools` 内置文件工具的路径围栏是否解除（沿用既有语义），`bypass` 控制是否
  沙箱。两者由同一个权限预设驱动，但不是同一个开关，合并它们会改变 0.1.x 的行为。
- **批准语义不变**。沙箱是执行边界，不是审批通道：`read-only` 下 `write_file` 依然走上
  一次「批准后放行」的既有路径。fs 侧的 `assertWritablePath` 已经就位，但工具层**没有**
  改用它做硬拒绝——那会与既有审批流程打架，属于产品决定而不是本次重构。
- 发布面新增 6 个子路径（`sandbox` / `sandbox-local` / `sandbox-windows-acl` /
  `sandbox-windows-acl/runner` / `fs-sandbox` / `execution-sandbox`），已同步
  `scripts/build.mjs`、根 `package.json` 的 `exports` 与 `test/publish.test.ts`。
- 新增可选依赖 `koffi`（FFI）：只在 Windows 机制里被 `import()`，缺失时探测失败并
  fail closed，不影响其它平台。esbuild 把它标为 `external`。

### 补充（2026-10）：Windows 优先 MXC

Windows 链改为 `windows-mxc → windows-acl`。新增机制库 `@tnega/sandbox-windows-mxc`，与
`sandbox-windows-acl` 同一地位（机制库，Provider 按需 `import()`），把一次受限调用翻译成
Microsoft eXecution Container 的请求，由 MXC 落策略并在请求结束时撤销。

- **为什么放在 ACL 前面**：MXC 不在工作区上留常驻 ACE，不要求调用者拥有工作区目录，受限进程
  里的管道 stdio 在参考实现验收的档位上可用；策略、档位与拒绝记录由 Microsoft 维护。
- **为什么 ACL 仍在链上**：MXC 需要 Windows 11 24H2+ 与一个单独安装的执行器（SDK 解包约
  108 MB，tnega 不自带）。没有它的宿主照旧走 ACL；两者都不可用才 `SANDBOX_UNAVAILABLE`。
- **探测即协商**：探测经 runner 在 MXC 里真的跑一次只读命令，按 `1.0.0 → 0.9.0-alpha` 依次试
  请求契约，选第一个跑通的。缝的词汇与事件面不变，`ConfinedArgv` 的形状不变。

### 补充（2026-10）：MXC 的读侧默认放开

MXC 的 AppContainer 档位没有环境读权限，只授予工作区时 `node` / `npm` / `pwsh` 这类装在工作区
之外的工具连加载都做不到（pwsh 7.7 之前还要求能读 `C:\` 根才肯启动）。挑「工具根」是猜不准的：
每个用户的工具链盘符都不同。所以 `mxcRead` 默认 `all`，把本机每个卷根作为只读根交给 MXC，
**与 ACL 链只收窄写的既有语义对齐**；需要读侧隔离的部署用 `mxcRead: 'roots'` 关回去。缝的词汇
不变（`SandboxExecutionPolicy` 里仍然没有读字段），这是 Provider 的默认值，不是新契约。

### 补充（2026-10）：命令网络

策略多了一个**独立于模式**的维度 `network`（`SandboxNetworkPolicy`）：`open`（默认，等同于
缺席）、`allowlist`（只能经过滤代理访问允许表命中、且未被拒绝表命中的目标）、`off`（没有网络）。
规则语法与判定顺序沿用 Anthropic sandbox-runtime：`example.com`、`*.example.com`（只含子域）、
`*`、IP 字面量（IPv6 带方括号），可带 `:port`；拒绝先于允许，两表都没命中即拒绝。判定是
Definition 里的纯函数（`decideNetworkAccess`），代理与设置界面共用一份。

- **机制**：Linux 用 bwrap `--unshare-net` 给命令一个只有回环的空网络，再由命令里的 `socat`
  把 `localhost:3128` 接到绑定进来的代理 Unix socket；macOS 用 Seatbelt `(deny network*)`，
  只放行到代理端口的回环连接；Windows 用 MXC 的代理模式（出站拒绝，宿主回环放行，
  `runtimeConfig.networkProxy` 指向代理），取「无身份回环代理」这一档，因为代理是宿主上没有
  包身份的普通进程。`off` 在三个平台上都不起代理。
- **过滤代理**是新的机制库 `@tnega/sandbox-network-proxy`：同一个口上说 HTTP（CONNECT 与
  绝对 URI）与 SOCKS5，放行后可以再经上游代理（设置里的 Network proxy，否则宿主的
  `HTTPS_PROXY`）出去。通配规则放行的名字若解析到回环、链路本地等本机地址仍拒绝 —— 只有逐字
  点名的规则才能放行它们；代理连接的是自己检查过的地址，DNS 换答案绕不过去。
- **仍然 fail closed**：选中的机制管不了网络（landlock、windows-acl、custom），或这台机器缺
  它所需的东西（Linux 缺 `socat`、Windows 构建低于 26100.9278 / 26200.9278 不接受代理模式），
  而策略要求 `allowlist` / `off` 时，`confine` 抛 `SANDBOX_UNAVAILABLE`，不以开放网络执行。
- **只能收紧**：`sandbox/pre-confine` 的监听器可以把网络改得更严，改宽即
  `SANDBOX_INVALID_POLICY`。代理的每次判定以 `sandbox/network` 只读广播；命令退出后，
  `ConfinedArgv.annotate` 把本次被拒的主机附在 stderr 末尾，模型知道该去设置里加哪个域名。
- **配置**：System Config 的 `sandbox.network`，设置里的 Tools & shell › Command network；
  每次执行都重新读，改了不必重启。`bypass` 仍然是「不要沙箱」，网络也不限制。
- **限制**：只有遵守代理环境变量的客户端能出网（HTTP/S 与 SOCKS5，Linux/macOS 的 git ssh 经
  `GIT_SSH_COMMAND` 走代理）；Windows 的 MXC 只认 HTTP/S 代理。按域名放行不检查 TLS 内容，
  允许 `github.com` 也就允许了经它中转的一切。

## 验证

- `packages/sandbox/sandbox/test/events.test.ts`：stub Provider 挂在真实 `Context` 上，
  覆盖事件顺序、只允许收紧的改写、吞事件被拒、`bypass` 被拒、不可用码的透传、观察者失败
  不改写结论、监听器随 fiber 卸载。stub 里不出现任何事件名 —— 这是「事件面对 Provider
  透明」的机器可验证证明。
- `packages/sandbox/sandbox-local/test/local.test.ts`：逐字钉死 bwrap / landlock /
  seatbelt / custom 的 argv 契约、链式回退、探测缓存、无链时的 `SANDBOX_UNAVAILABLE`
  与 `status()`、tempRoot 落在工作区内的拒绝。
- `packages/sandbox/sandbox-local/test/e2e-posix.test.ts`：**真实机制**的端到端验证
  （本机没有对应二进制时整组跳过，Linux/macOS 上真跑）：只读拒写、workspace-write
  可写、退出码原样镜像、bwrap 下宿主 `/tmp` 不可见。
- `packages/sandbox/fs-sandbox/test/containment.test.ts`：词法包含、共享前缀、身份回退
  （junction 别名）、根 stat 不到时的 fail closed、普通文件段。
- `packages/sandbox/fs-sandbox/test/fs-sandbox.test.ts`：`resolveInside` 的逃逸与 symlink
  逃逸、按模式的可写判定。
- `packages/sandbox/execution-sandbox/test/execution-sandbox.test.ts`：shell 命令被装成
  显式 argv、argv 进程的处理、`bypass` 透传、无后端时**不回退**、无 Provider 时报错。
- `packages/sandbox/sandbox-windows-acl/test/*`：SID 派生、路径边界、runner 参数校验、
  真实 DACL 生命周期、真实受限令牌 E2E（含含引号与重定向的 `cmd` 命令）、注入式失败
  路径（见该包 README）。
- 端到端：`packages/cli/test/tools-e2e.test.ts` 的 `allowShell` 用例现在会真的经过沙箱。
- 命令网络：`packages/sandbox/sandbox/test/network.test.ts`（语法、判定、只能收紧、
  `sandbox/network`）、`packages/sandbox/sandbox-network-proxy/test/proxy.test.ts`（HTTP、
  CONNECT、SOCKS5、上游链式、本机地址守卫）、`packages/sandbox/sandbox-local/test/network.test.ts`
  （各机制的 argv 与 fail closed）、`e2e-posix.test.ts` 的「bwrap network end to end」（有 bwrap
  与 socat 时真跑 curl）、`sandbox-windows-mxc/test/runner.test.ts` 的 `--network` 与请求字段。
