# `@tnega/tool-sessions`

注册两个只读模型工具，让 Agent 像用户在侧栏里那样查找过去的 Session，范围是 tnega 已知的所有 Workspace，而不只是当前这个：

- `search_sessions`：按标题与用户 / 助手消息正文查找（忽略大小写），每个 Session 报一次，带 Workspace、标题、更新时间与命中片段。可用 `workspace` 只查一个。
- `read_session`：读某个 Session 的对话（用户与助手消息，按时间顺序），默认最近 20 条，可用 `before` 往前翻页。

挂载配置 `{ workspaces }` 由 composition 层提供（宿主读系统配置里的 Workspace 列表）；插件不自己读配置。`read_session` 只接受这份列表里的 Workspace，以只读方式读磁盘上的事件，不打开、不修复正在运行的 Session 日志。两个工具都不碰 Workspace 文件、网络或进程。
