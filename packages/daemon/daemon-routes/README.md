# `@tnega/daemon-routes`

本机一侧的 HTTP 路由，一个插件挂齐：Workbench 的文件（`/api/files*`，经 `fsLocal` 提供的 `ctx.fs`）、终端（`/api/terminals`，自带 `TerminalManager`，随插件 dispose）、浏览器视图（`/api/browser`）、文件夹选择（`/api/folder-picker`）、沙箱与 Computer use 的安装提示（`/api/sandbox/*`、`/api/computer/setup`）。

这些路由都作用于「人坐在前面的那台机器」，所以从 Daemon 一侧挂载。本机模式下 `packages/host` 的 `startWebServer` 直接挂它，URL 与响应和以前一样；不服务本机的宿主（v2 服务器）不挂，这些 URL 就是 404。

```ts
await ctx.plugin(daemonRoutes, { browser: () => browserHost, computerDriverPath })
```

浏览器宿主仍由宿主持有：Agent 的 `browser_*` 工具驱动的是同一个页面，`browser-remote` 之前它不搬家。设计见 `docs/plans/v2-package-changes.md` P5。
