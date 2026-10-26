# `@tnega/tool-web-search`

模型可见的 `web_search` 与 `web_fetch`，走 DeepSeek 的 Search & Fetch API
（<https://api-docs.deepseek.com/guides/search/>，与对话 API 同一个 Bearer key）。

- `web_search`：`POST /v1/tools/search`。入参 `query`（≤128 字符，支持 `site:`、`-site:`、`"短语"`、`-词`、`lang:`、`after:`、`before:`）、可选 `question`（作为 `ori_question`）与 `count`（1–20，默认 8）。返回 `{ results: [{ title, url, summary, site, publishedAt }] }`，按相关度排序，同一 URL 只留一条。
- `web_fetch`：`POST /v1/tools/fetch`，把一个公开网页读成 Markdown，返回 `{ url, title, content, truncated }`，正文超过 60 000 字符截断。原始 HTTP（API、文件、响应头）仍用 `tool-web-fetch` 的 `http_get`。

失败按文档的状态码说明原因（401 key、402 余额、429 限流……）。没有 key 时两个工具都提示设置 `DEEPSEEK_API_KEY`。

```ts
await ctx.plugin(toolWebSearch, { apiKey })
```
