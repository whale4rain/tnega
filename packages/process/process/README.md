# `@tnega/process`

进程缝的 **Service Definition**：拥有 `ctx.process`。v2 计划 P2（`docs/plans/v2-package-changes.md`）。

```
@tnega/process-local (Provider：本机 spawn / HTTP) ─┐
@tnega/execution-sandbox、@tnega/execution-secrets   ├─→ @tnega/process
  (ExecutionProvider 装饰器)                        │
@tnega/tool-shell、@tnega/tool-web-fetch (Consumer) ┘
```

一个作用域的命令、argv 进程与 HTTP 抓取都经过这里，所以它们可以在另一台机器上跑：本机
Provider 在这台电脑上 spawn，远端 Provider（P4 的 `process-remote`）把同样的调用发给 daemon。

## 契约

- 词汇：`ShellRequest` / `ProcessRequest` / `HttpRequest` 与结果类型、`BackgroundProcess`、
  `ExecutionProvider`（一个边界值）、`isSandboxPipeDenial`、`ProcessRegistry`（后台进程登记表，
  与机器无关）。
- `ProcessService`（抽象 `Service`，`ctx.process`）实现 `ExecutionProvider`。`ProcessBoundary`
  用一个边界值提供它；`processBoundary` 插件是 composition 层的挂载点：先把 Provider 用装饰器包好，
  再挂一次。装饰器是值的包装，不是服务，所以带沙箱的作用域从 `ctx.process` 只能拿到装饰后的链。
- `startShell` / `startProcess` 只在边界本身有时才存在；`describeShell()` 告诉 `shell` 工具
  这台机器的 shell 语法，装饰器原样转发。
- 一个作用域只挂一个 Provider；Project 线程用 `isolate('process')`。
