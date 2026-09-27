# 沙箱缝：把「受限执行」拆成 Service Definition / Service Provider / Consumer

> 状态：当前
> 取代关系：无
> 当前实现：`packages/sandbox/sandbox/README.md`、`packages/sandbox/sandbox-local/README.md`、`packages/sandbox/execution-sandbox/README.md`、`packages/sandbox/fs-sandbox/README.md`、`packages/sandbox/sandbox-windows-acl/README.md`
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
Permission 完全同名，所以 CLI / Web API / Session 元数据不需要任何映射。`bypass` 在
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
- **网络不在词汇内**。当前没有任何后端限制网络，所以 `SandboxMode` 只声明文件效果；
  假装它管网络比不管更糟。`fetchHttp` 直接透传。
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
