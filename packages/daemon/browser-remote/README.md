# `@tnega/browser-remote`

`ctx.browser` 的远端 **Provider**：浏览器跑在 Daemon 那台机器上（`tnega daemon --browser`，独立的配置文件），Runtime 经 `forwardService` 驱动它。

- `act` 仍由 `@tnega/browser` 的基类派发 `browser/pre-action` 与 `browser/action`：策略和审计在 Runtime 一侧，Daemon 只收到已经放行的动作（`run`）。
- `page()`、`tabs()`、`console()`、`network()` 是同步方法，读的是本地缓存：挂载时打开一条可续传的 `watch` 流，Daemon 推来页面、标签页的变化和每条控制台、网络记录（各留最近 `DEFAULT_BROWSER_LOG_LIMIT` 条）。
- 远端的 `BrowserError` 还原成本地的，带原来的 `code`；取消（`signal`）经 `$/cancel` 传到 Daemon。
- 不转发画面帧：Workbench 的实时画面要等服务端（M3）接上 Daemon 后再做，且只在有人看时才发。
- Daemon 没宣告 `browser` 时挂载即失败。

```ts
await ctx.plugin(browserRemote, { link })
await ctx.plugin(toolBrowser)
```
