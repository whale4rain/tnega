# `@tnega/browser-playwright`

浏览器缝的 Service Provider，基于 [Playwright](https://playwright.dev)（`playwright-core`）。快照用 `page.ariaSnapshot({ mode: 'ai' })`，元素用 `aria-ref=eN` 选择器定位——与 Playwright MCP 相同的机制。

页面来源（`PageSource`）可替换：

- `launchPageSource()`：自己启动一个全新 profile 的浏览器。Windows 优先系统 Edge，macOS / Linux 优先 Chrome，最后回退 Playwright 自带 Chromium；无需额外下载。`tnega web` 使用它。
- `cdpPageSource()`：通过 CDP 附着到另一个 Chromium 里**已经存在**的页面，并且只驱动给定 target id 的那一页。桌面端用它驱动内嵌的 `WebContentsView`，应用自己的界面永远不会被触碰。

`PlaywrightBrowserHost` 持有页面、console 与网络记录，可跨多次 Agent Run 共享；插件 dispose 时只关闭自己启动的浏览器，从不关闭传入的 host。

```ts
await ctx.plugin(browserPlaywright, { launch: { headless: true } })
await ctx.plugin(browserPlaywright, { host }) // 共享的 host
```
