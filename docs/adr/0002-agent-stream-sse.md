# Agent 流式协议采用单请求 SSE 与归一化事件

dsh 用常驻 WebSocket `/api/remote.mux` 复用 follow/control 逻辑流，并持久化每个 token delta。tnega 选择单请求 `POST /api/sessions/:id/runs` 返回 `text/event-stream`：SSE 只发归一化事件（`message_start` / `message_delta` / `message_stop`、`toolcall_start` / `toolcall_end`、`tool/start`、`tool/end`），浏览器断连即取消，delta 不落盘；SessionLog 仍是持久真源，只落最终 message 与 tool 事件。相比 dsh 失去断线后 token 级重放保真，换来单请求、无长连接状态机与更小的实现面。
