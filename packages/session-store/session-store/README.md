# `@tnega/session-store`

Session 存储缝的 **Service Definition**：`ctx.sessionStore`。Session 日志存在哪里、怎么列出、读取与追加。本机 Provider 是 `@tnega/session-store-jsonl`（`~/.tnega` 下每个 Session 一个 JSONL 文件），v2 服务端是 `@tnega/session-store-pg`（Postgres）。

- **只追加。** `append(workspace, id, { expectedSeq, events, owner })` 把一批事件整批存到 `expectedSeq + 1 …`，否则回答 `conflict` 和当前的 `headSeq`，什么都不存。
- **重试安全。** 一批事件的 id 全都已存、内容也相同（`canonicalEvent`，与键的顺序无关）时，回答 `committed` 和已存的 seq；同 id 不同内容，或只存了一部分，是 `conflict`。
- **一个写入者。** 追加要先 `lease(workspace, id, owner)`；别人持有时抛 `SessionLeaseError`。30 秒没人续的租约可以被接管。
- **历史就是日志。** `summary`、`snapshot` 都是事件的折叠；`read` 原样返回追加的事件。
- `backend(workspace, id)` 给 `SessionLog` 用的存储（`@tnega/session` 的 `SessionBackend`），运行中的 Agent 经它写同一份日志。

`WorkspaceKey` 是存储认的工作区名：本机是文件夹路径，服务端是工作区 id。

两个 Provider 共用的折叠（摘要、分页、快照、元数据补丁、fork 的事件体、搜索片段）在 `src/folds.ts`，所以同样的事件在两边得到同样的回答。
