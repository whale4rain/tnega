# `@tnega/tool-session-search`

Session 搜索缝的 Consumer：三个只读模型工具，依赖 `tools` 与 `sessionSearch`。

- `search_sessions({ query, workspace? })`：跨所有已知 Workspace 搜索，最好的在前，最多 20 个；不含当前 Session（按 `agentId`）；结果被截断时提示模型加词收窄。
- `search_session({ session, query, workspace? })`：在一个 Session 内搜索，返回带 seq 的命中。
- `read_session({ session, around?, before?, limit?, workspace? })`：按顺序读一段对话，可围绕某个 seq 或往前翻页。

`session` 接受用户贴的 `tnega://session/...` 链接或裸 id；只接受挂载配置 `{ workspaces }` 列出的 Workspace（宿主读系统配置）。三个工具在审批守卫里属于只读，任何权限模式下都不询问。
