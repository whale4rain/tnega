# `@tnega/tool-web-fetch`

模型可见的 `http_get`：经 `@tnega/execution` 的 `fetchHttp` 抓取一个 http(s) URL。
网络是高权限能力，组合层只在显式 `allowNetwork` 时挂载；私网地址默认拒绝，
`allowPrivateNetwork` 只在 `bypass` 权限下打开。

```ts
await ctx.plugin(toolWebFetch, { execution })
```
