# `@tnega/sandbox-network-proxy`

命令网络的过滤代理：沙箱里的命令只能经它出网，它对每个目标问一次「放不放」，放行就接通，
不放就拒绝并说明原因。它是 `@tnega/sandbox-local` 按需 `import` 的**机制库**，与
`sandbox-windows-mxc` 同一地位：没有 ctx key，不注册服务、事件或工具，判定规则由调用方给。

## 做什么

```ts
const proxy = await startNetworkProxy({ host: '127.0.0.1', port: 0 } /* 或 { path: 'proxy.sock' } */, {
  decide: ({ host, port }) => decideNetworkAccess(policy, host, port),  // 来自 @tnega/sandbox
  upstream: () => 'http://127.0.0.1:7890',  // 可选：放行后经上游代理出去
  noProxy: () => process.env.NO_PROXY,      // 可选：不走上游的目标
  onDecision: decision => { /* 审计、sandbox/network */ },
})
proxy.address            // { host, port } 或 { path }
proxy.denialsSince(t)    // 某时刻以来被拒的连接，用来告诉模型去设置里加哪个域名
await proxy.close()
```

- **一个口，两种协议**：首字节是 `0x05` 就按 SOCKS5（只做无认证的 CONNECT），否则按 HTTP
  （`CONNECT host:port` 隧道，以及绝对 URI 的普通请求）。
- **拒绝要说清楚**：HTTP 回 403，正文是 `tnega sandbox blocked host:port: <原因>`；SOCKS5 回
  `0x02`（规则不允许）。
- **上游**：只支持 `http://`（可带 Basic 认证）。普通 HTTP 请求转成发给上游的绝对 URI，
  其余经上游的 CONNECT。`NO_PROXY` 命中的目标直连。
- **本机地址守卫**：直连时先解析、检查**全部**答案，再连检查过的地址（防 DNS rebinding）。
  回环、未指定、链路本地（含 169.254.169.254）、组播被拒，除非允许它的规则**逐字点名**了这个
  主机（`decide` 返回 `named: true`）。私有网段不拦：内网域名与 fake-IP 模式的代理需要它们。

## 不做什么

- 不看 TLS 内容：放行 `github.com:443` 就是放行这条隧道里的一切。
- 不判定规则：语法与顺序在 `@tnega/sandbox` 的 `decideNetworkAccess` 里，只写一份。
- 不负责「命令只能经它出网」：那是机制的事（bwrap 的空网络、Seatbelt 规则、MXC 代理模式）。

## 为什么是一个包

约 670 行 `src/`，只有一件事：按给定判定转发连接。HTTP、SOCKS5 握手、上游链式与直连守卫是它
的几个步骤，不是可以单独替换的能力。

## 测试

`test/proxy.test.ts`：在回环上起一个源站，覆盖 CONNECT、普通 HTTP、SOCKS5、拒绝说明、通配规则
解析到本机地址被拒、经上游链式（被拒的目标不会到达上游）、Unix socket 监听，以及
`isLocalAddress`、`parseUpstreamProxy`、`bypassesUpstream`。
