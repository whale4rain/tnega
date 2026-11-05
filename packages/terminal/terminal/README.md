# `@tnega/terminal`

Workbench 终端缝的 **Service Definition**：`ctx.terminals`。终端是人自己的 shell（不是 Agent 工具，不在沙箱里），所以它跟着「人坐在前面的那台机器」，也可以在一台 Daemon 上。

- `Terminals` / `TerminalService`：`list`、`create`、`attach`（先重放 scrollback，再推流；`onEnd` 表示机器那头没了）、`write`、`resize`、`close`，全部异步，好让 Provider 在另一台机器上。
- `TerminalError(message, status)`：路由按 `status` 回 HTTP 状态；远端 Provider 把同名远端错误还原成它。
- `isTerminalInfo` / `isTerminalEvent`：检查跨线来的值。

Provider：`@tnega/terminal-local`（本机 PTY）、`@tnega/terminal-remote`（Daemon）。Consumer：`@tnega/terminal-routes`（`/api/terminals`）。
