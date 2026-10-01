# `@tnega/sandbox`

沙箱能力的 Service Definition：拥有 `ctx.sandbox`、模式与策略词汇、稳定错误码，以及
`canonicalPath` / `writableRoots` 这份共享的根推导。它不包含任何机制 —— bwrap、
landlock、Seatbelt、Windows ACL 都属于 Provider。

## 一条缝的三个角色

```
@tnega/sandbox-local (Provider) ─┐
                                 ├─→ @tnega/sandbox (ctx.sandbox)
@tnega/execution-sandbox (Consumer) ─┘
```

Consumer 只 import 本包，从不 import 具体 Provider，也不枚举后端。Provider 的挑选属于
composition 层（`packages/cli/src/commands.ts`、`packages/cli/src/server.ts`、
`packages/cli/src/project-host.ts`）。

## 契约

```ts
abstract class SandboxService extends Service {
  protected abstract runConfine(request: SandboxMechanismRequest): ConfinedArgv | Promise<ConfinedArgv>
  abstract status(): Promise<SandboxBackendStatus>
  confine(request: SandboxConfineRequest): Promise<ConfinedArgv>
}
```

- **fail closed**：`confine` 要么交出一个真正受强制执行的 argv，要么抛错。没有任何可用
  后端时抛 `SandboxUnavailableError`（码 `SANDBOX_UNAVAILABLE`），调用方必须放弃执行，
  而不是回退到非受限执行。参考实现把这条写成「silent unconfined passthrough is
  forbidden」，本包沿用。
- **`bypass` 不是策略**：它表示「不要沙箱」，送进 `confine` 即
  `SANDBOX_INVALID_POLICY`。绕过沙箱是调用方的显式选择，不该伪装成一次受限执行。
- **结果与拒绝分开**：Provider 交出的 `ConfinedArgv` 里带着它自己的 `enforcement`
  （`full` / `partial`）与 `denialSignatures`。后者必须是**本后端**的拒绝方言，不得是跨
  后端并集 —— 混在一起会把「runner 坏了」读成「被策略拒绝」。
- **runner 失败不能靠退出码断言**：`RunnerFailureRule` 的判定顺序是
  `allowedExitCodes` → 整行剔除 `informationalLines` → 逐行匹配 `fatalSignatures`。
- **模式只声明文件效果**：网络与进程可见性不在词汇里，因为当前没有后端限制它们。

## 事件面

| 事件 | 派发方式 | 作用 |
|---|---|---|
| `sandbox/pre-confine` | `waterfallAsync` | 收紧策略或改写 argv；不交出合法事件即失败 |
| `sandbox/confined` | `parallel` | 事后通知（审计、UI），只读 |
| `sandbox/error` | `parallel` | 事后通知，含 `SANDBOX_*` 码，只读 |

改写点遵循 core 的 waterfall 约定（与 `agent/pre-step`、`tools/pre-execute`、
`search/pre-search` 一致）：监听器就地改写负载后调用无参 `next()`。**监听器只能收紧**
—— 把模式改回 `bypass` 会以 `SANDBOX_INVALID_POLICY` 失败；一个说不清楚话的策略监听器
不能变成一次不受限执行。两个观察事件是只读的：观察者失败被吞掉，不改写权威结论。

## 默认值与根

`resolveSandboxPolicy` 是默认值唯一的落点：模式默认 `read-only`（fail-safe），
`workspaceRoot` 必须是绝对路径（相对路径的含义随进程 cwd 漂移，而沙箱边界不能漂移）。

`writableRoots` 是 Provider（mount 绑定、ACL 授权）与 `@tnega/fs-sandbox`（写围栏）
**共用的同一份** allow-list：

- `read-only` / `bypass` → 空集；
- `workspace-write` → workspace 加临时区：显式 `tempRoot`，否则 Windows 上是
  `os.tmpdir()`、POSIX 上是 `/tmp` 与 `os.tmpdir()`。所有根都过 `canonicalPath`
  （`realpathSync.native`），因为 Seatbelt 与 Windows ACL 匹配的是已解析路径。

## 测试

`test/vocabulary.test.ts`、`test/events.test.ts`：词汇与默认值、stub Provider 上的事件
契约。stub 里不出现任何事件名，这是「事件面对 Provider 透明」的机器可验证证明。
