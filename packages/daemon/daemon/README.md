# `@tnega/daemon`

Daemon：在一台机器上把若干工作区的文件与命令提供给 Runtime。`tnega daemon` 是它的命令行入口。

```ts
const daemon = startDaemon({
  connect: () => connectWebSocket('wss://tnega.example.com/daemon', { token }),
  workspaces: [{ path: '/home/me/project' }],
})
await daemon.ready
// …
await daemon.close() // 不再重连、取消进行中的调用、杀掉它启动的后台进程、断开连接
```

- **工作区绑定**：每个调用带 `workspaceId`，只接受握手时宣告过的 id（否则 `WORKSPACE_DENIED`）；文件和命令目录都用 `@tnega/fs-sandbox` 的 `resolveInside` 围在工作区内，远端不提供 `bypass` 的「工作区外路径」。
- **沙箱**：每条命令都经 `sandboxedExecution`，模式取自调用里的 `sandbox`；调用没带就按 `read-only`。没有能强制策略的机制时照常 fail closed（`SANDBOX_UNAVAILABLE`）。
- **幂等**：同一 `callId` 的重试拿到第一次的答案，不会再执行一次（最近 512 个）。
- **重连**：断线后按指数退避重新拨号并重新宣告；握手被拒（版本、设备）就停止。
- **传输安全**：`connectWebSocket` 只接受 `wss://`，或连本机的 `ws://localhost`，在发出 token 之前就拒绝。

`test/loopback.ts` 用进程内的内存传输跑一个 Daemon；`contract-*.test.ts` 用它把 `tool-fs` 与 shell 的现有测试原样跑一遍。
