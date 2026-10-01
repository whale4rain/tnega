# `@tnega/browser`

浏览器缝的 Service Definition：拥有 `ctx.browser` 与 `browser/*` 事件面，只承载词汇、错误码与默认值。

- 动作统一走 `act(action)`：先派发 `browser/pre-action`（waterfall，可改写动作或设置 `deny` 拒绝），再派发 `browser/action`（parallel，成功与失败都通知）。Provider 只实现 `runAction`，无法绕过策略与审计。
- 观察（`snapshot` / `screenshot` / `console` / `network`）不改变页面。
- 元素用最近一次快照里的 `ref`（如 `e12`）定位；页面里已经不存在的 ref 以 `BROWSER_STALE_REF` 失败，绝不点到别处。
- `isLocalUrl` 判定本地开发地址（loopback、`*.localhost`、`*.test`），权限层用它区分本地调试与对外操作。

Provider：`@tnega/browser-playwright`。Consumer：`@tnega/tool-browser`。
