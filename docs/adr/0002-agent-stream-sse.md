# Agent 流式协议采用单请求 SSE 与归一化事件

> 状态：部分取代
> 取代关系：流传输决策仍适用；“delta 不落盘”的持久化细节已由 `assistant/chunk` 与 `assistant/attempt` 设计取代
> 当前实现：SSE 见 `apps/web` 与 `packages/cli`；Session 事件事实见 `packages/session/README.md`

dsh 用常驻 WebSocket `/api/remote.mux` 复用 follow/control 逻辑流，并持久化每个 token delta。tnega 选择单请求 `POST /api/sessions/:id/runs` 返回 `text/event-stream`：SSE 只发归一化事件（`message_start` / `message_delta` / `message_stop`、`toolcall_start` / `toolcall_end`、`tool/start`、`tool/end`），浏览器断连即取消。SessionLog 仍是持久真源；当前 raw 层另外记录 `assistant/chunk` 与失败尝试的 `assistant/attempt`，模型 surface 仍只包含最终可见消息和工具结果。相比 dsh 失去断线后 token 级重放保真，换来单请求、无长连接状态机与更小的实现面。
