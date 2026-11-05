# `@tnega/terminal-routes`

Workbench 终端的 HTTP 路由（`/api/terminals`、`/stream`、`/input`、`/resize`），只读 `ctx.terminals`，所以终端在本机还是在 Daemon 上，URL 与响应都一样。机器那头断开时结束 SSE，面板会重新附着。
