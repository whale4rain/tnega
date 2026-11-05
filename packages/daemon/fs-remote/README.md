# `@tnega/fs-remote`

`ctx.fs` 的远端 **Provider**（Service Definition 见 `@tnega/fs`）：每个 `WorkspaceFs` 方法变成一次 `fs/*` 协议调用，发给连上的 Daemon。

- `fsRemote` 插件取 `{ link }`；`ctx.fs.workspace(root)` 只认 Daemon 宣告过的工作区，其余直接抛错（`announcedWorkspace`）。
- 远端的 `FsError`（`FS_EXISTS`、`FS_BUSY`）还原成本地的 `FsError`，Consumer 看到的错误与本机一致。

由 composition 层（`packages/runtime` 的 `capability:fs`，`machine` 选项）挂载，Consumer 从不 import 本包。
