# 修复报告：Agent 稳定性与并发/持久化

> 状态：历史记录
> 取代关系：无；本文记录一次已完成修复，不定义当前架构
> 当前实现：仅历史修复报告；当前行为以 `packages/agent`、`packages/session` 和相关测试为准

日期：2026-08-29

## 目标

修复 Web 会话运行中的三类问题：shell 命令挂起不释放运行锁、工具执行异常导致会话出现悬空 `tool-call`、同一会话在 Windows 路径大小写不同时绕过并发保护；同时补全 `tool-result` 的结构化失败字段。

## 根因

1. `runShellCommand` 仅依赖 `spawn` 的 `timeout`，只终止直接子进程。shell 的孙进程继续持有 stdout 管道时 `close` 永不触发，`activeRuns` 也不会释放。
2. agent 调用 `tools.execute` 没有 `try/catch`。工具不存在或钩子抛错时，已写入的 `tool-call` 没有对应 `tool-result`，会话投影会留下未闭合的 assistant 消息并污染后续请求。
3. `runKey` 直接使用 `resolve(workspace)`。Windows 下 `D:\...` 与 `d:\...` 不相等，导致同一 session 可绕过 409 并发保护。
4. `ToolResultPayload` 只保留 `ok/message`，丢失 `error.name` 和 `durationMs`；前端只能靠 `error: ` 文本前缀判断失败。

## 修复

- `packages/tools`：shell 改为接收 `AbortSignal`，超时或取消时按平台清理进程树（Windows `taskkill /t /f`，POSIX 进程组 `SIGKILL`），并返回失败的 `tool-result`。
- `packages/agent`：工具执行包上 `try/catch`，任何异常都转换为失败的 `ToolResult` 并闭合 `tool-result`，run 继续进入下一步。
- `packages/cli`：`runKey` 在 Windows 下对 workspace 真实路径做大小写归一化，同 session 并发统一返回 409。
- `packages/session` + `apps/web`：`ToolResultPayload` 增加 `durationMs` 和 `error.name`；失败消息投影带 `toolOk/toolError`，前端展示不再依赖文本前缀（旧数据仍兼容前缀回退）。

## 提交

- `f42db6c` fix(tools): shell 超时或取消时清理进程树并返回失败
- `3ad2c3f` fix(agent): 工具执行异常闭合 tool-result 并持久化错误字段
- `d3de764` fix(cli): 同会话并发锁忽略 Windows 路径大小写差异

## 验证

- `pnpm test`：23 个测试文件通过、3 个跳过；254 个用例通过、5 个跳过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。

## 余项

- Windows 大小写并发测试仅在 win32 下运行，POSIX 路径本身区分大小写，不适用。
- 旧会话文件中没有 `toolOk/toolError` 的历史 `tool-result` 仍按 `error: ` 前缀兼容展示。
- shell 进程树清理依赖 `taskkill`/进程组；极端情况下由目标命令自己脱离进程组或守护化的进程可能无法被清理。
