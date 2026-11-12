# `@tnega/daemon-gateway`

服务器的 daemon 入口：`/daemon` 上的 WebSocket，`tnega daemon --server` 和 box 里的 daemon 用 `Authorization: Bearer <daemon 设备 token>` 拨进来。

- token 必须是启用账号的、没撤销的 **daemon** 设备（`ctx.accounts.authenticate`；浏览器的 client token 被拒，403）。没有或无效的 token 是 401，握手头不对是 400，都不升级连接。
- 升级后在这条 socket 上跑协议握手（`acceptDaemon`），链接登记进 `ctx.daemons`，键是服务器的设备 id。心跳由协议层负责，超时断开。
- 每分钟（`recheckMs`）重新校验一次 token：设备被撤销或账号被停用，连着的 daemon 会被断开，而不只是下次连不上。
- `listen` 选项另开一个只服务 `/daemon` 的监听（其他请求 404），给同一台主机上的 gVisor box 用，web 服务器本身可以继续只听 loopback。
- `src/websocket.ts` 是服务器一端的 RFC 6455：文本消息、分片、ping/pong、关闭；客户端帧必须带掩码，超过 128 MiB 的消息或协议错误会关连接。

挂在 web 服务器的通用 upgrade 挂载点上（`webServer.registerUpgrade`），宿主只负责把 HTTP upgrade 分发过来。

测试：`test/daemon-gateway.test.ts` 用真的 `@tnega/daemon` 客户端、PGlite 上的账号：配对码换 token 再连上、无 token / 错 token / 浏览器 token 被拒、撤销与停用会断开已连的 daemon。
