# Session search seam

让 Agent 查找用户过去的 Session，范围是 app 列出的所有 Workspace。按能力缝分成三个角色（见 `docs/adr/0006-capability-seams.md`）：

- `session-search`：Service Definition，拥有 `ctx.sessionSearch`，以及会话链接格式 `tnega://session/<id>?workspace=<path>` 与事件 → 可搜索文本的唯一规则（工具结果走 `renderToolResult`）。
- `session-search-sqlite`：Provider，一个 SQLite FTS5（trigram）索引，文件在 tnega home 的 `session-index.sqlite`，整个宿主共用一份。
- `tool-session-search`：Consumer，模型可见的 `search_sessions` / `search_session` / `read_session`。

宿主（`packages/host/src/support.ts` 的 `hostPlugins`）为每个 run 挂载 Provider 与 Consumer，并把系统配置里的 Workspace 列表交给 Consumer；能看哪些 Workspace 由调用方决定，Provider 不判断权限。
