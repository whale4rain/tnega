# `@tnega/session-search`

Session 搜索缝的 Service Definition：`ctx.sessionSearch`（`SessionSearchService`）。

- `searchSessions`：跨 Session 搜索，最好的在前，调用方给出可搜的 Workspace 与要排除的当前 Session。
- `searchEvents`：一个 Session 内的命中，按发生顺序给出 seq。
- `read`：一个 Session 的一段对话（消息、工具调用与结果），可按 `around` / `before` 定位。
- `locate`：在给定 Workspace 中找到某个 Session id。

点名单个 Session 的调用（`searchEvents`、`read`）都算一次使用：有上限的 Provider 据此保留常用的 Session，并重新索引被丢弃的那一个。

另导出 `sessionEventText`（索引与阅读共用的事件文本规则）以及 `formatSessionLink` / `parseSessionLink`（`tnega://session/<id>?workspace=<path>`；Web 端 `@tnega/client` 的 `sessionLink` 生成同一格式）。
