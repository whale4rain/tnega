# `@tnega/terminal-remote`

`ctx.terminals` 的远端 **Provider**：每个方法是一次经 `forwardService` 转发的调用，`attach` 是一条可续传的流（`stream/*`）。远端的 `TerminalError` 还原成本地的，带原来的 HTTP 状态；Daemon 没宣告 `terminals` 时挂载即失败。

```ts
await ctx.plugin(terminalRemote, { link })
await ctx.plugin(terminalRoutes)
```
