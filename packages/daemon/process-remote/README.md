# `@tnega/process-remote`

`ExecutionProvider` 的远端实现：命令、后台进程和 HTTP 请求发到 Daemon 执行。

- `remoteExecutionProvider(link, { workspaceId, sandbox })`：`runShell` / `runProcess` 以 `process/output` 通知流式回传输出；`startShell` / `startProcess` 跟随 `process/tail` 与 `process/exit`，连接断开时报告进程已不可达。
- `sandbox` 每次调用时读取，Runtime 决定模式、Daemon 负责强制；不传时 Daemon 按 `read-only` 执行。
- 由 composition 层用 secrets 装饰器包好，作为 `ctx.process` 提供（`packages/runtime` 的远端 sandbox capability）。
