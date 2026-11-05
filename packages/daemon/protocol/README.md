# `@tnega/daemon-protocol`

Runtime 与 Daemon 之间的线协议：JSON-RPC 2.0，纯 JSON，字节用 base64 并有上限（`MAX_PAYLOAD_BYTES`）。

- `methods.ts`：`PROTOCOL_VERSION`（接受 N 与 N-1）、方法表 `DaemonMethods`（`initialize`、`fs/*`、`process/*`、`http/fetch`）、通知（`process/output`、`process/tail`、`process/exit`）、错误码 `RpcErrorCode` 与保留远端错误名和 code 的 `RemoteError`。
- `peer.ts`：`Peer` 一端，请求 / 通知 / `$/cancel` 取消 / `$/heartbeat` 心跳（默认 10 s 一次，30 s 听不到就断开）；连接断开时所有挂起调用以 `CONNECTION_LOST` 失败，正在执行的处理器收到 abort。
- `link.ts`：Runtime 一侧。`acceptDaemon` 完成握手（版本不对就以 `VERSION_REFUSED` 拒绝并挂断），得到 `DaemonLink`；修改类调用自动带 `callId`，重试时 Daemon 认得出来、只执行一次。
- `forward.ts`：通用的 Service 转发。`forwardService(link, name)` 把 Daemon 暴露的任一 Service 的方法变成 `service/call`，把交回监听器的方法变成流（`stream/open`，编号的 `stream/event`，`stream/end`）；`resumeStream` 在新连接上只补回错过的事件（Daemon 不再持有就是 `STREAM_LOST`）。终端是第一个用户，浏览器与 Computer use 之后沿用。
- `transport.ts`：`Transport` 接口与进程内的 `memoryTransportPair()`（仍然逐条序列化成 JSON）。

本包只有词汇，没有实现；Daemon 见 `@tnega/daemon`，远端 Provider 见 `@tnega/fs-remote`、`@tnega/process-remote`。设计见 `docs/plans/v2-package-changes.md` P4。
