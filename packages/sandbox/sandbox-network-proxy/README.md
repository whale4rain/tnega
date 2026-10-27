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
  （`CONNECT host:port` 隧道、绝对 URI 的普通请求，以及协议升级）。
- **协议升级**（WebSocket 等）：判定过的目标收到原样的 `Upgrade`/`Connection` 头，由源站回
  `101`，之后两个方向都是字节流。不能把 `Upgrade` 当 hop-by-hop 头剥掉：剥了之后源站收到的是
  普通请求、回一个 `200`，客户端就停在「连上了但握手失败」上。`wss://` 不必特殊处理，它走 CONNECT。
- **拒绝要说清楚**：HTTP 回 403，正文是 `tnega sandbox blocked host:port: <原因>`；SOCKS5 回
  `0x02`（规则不允许）。
- **上游**：只支持 `http://`（可带 Basic 认证）。普通 HTTP 请求转成发给上游的绝对 URI，
  其余经上游的 CONNECT。`NO_PROXY` 命中的目标直连。交给上游之前，规则没点名的名字先在本地解析一次：
  答案里有本机地址就拦下；本地解析不了（只有上游能解析的网络）就照常交给上游。
- **本机地址守卫**：直连时先解析、检查**全部**答案，再连检查过的地址（防 DNS rebinding）。
  私有网段不拦：内网域名与 fake-IP 模式的代理需要它们。被拒的具体集合见下节。

## 判定的顺序（改这个文件前先读这段）

一次连接固定走这四步，顺序本身是契约：

1. `decide`：规则判定，**不触网、不解析**。拒绝就在这里结束（HTTP 403 / SOCKS5 `0x02`）。
2. 上游选择：`upstream` / `NO_PROXY` 决定直连还是经上游。
3. 地址检查：只有已放行的目标才解析。直连时检查全部答案再连已检查的地址；经上游时
   本地尽力解析一次（解析失败就交给上游）。`named: true` 的规则跳过这一步。
4. 记账与转发。

**为什么第 1 步必须在解析之前**：解析会把主机名发给 DNS 服务器。先解析再判定，等于把
「你要拒的主机名」告诉 DNS。Codex 在 0.163.0 修的就是这个（它当时先查 DNS 后判权限）；
`test/proxy.test.ts` 里有一条用例守住「被拒目标不触发 `resolve`」，改顺序会直接报错。

## 被拒的本机地址集

除非允许该主机的规则**逐字点名**了它（`decide` 返回 `named: true`），以下都拒：

- 回环 `127.0.0.0/8`、`::1`；未指定 `0.0.0.0/8`、`::`；
- 链路本地 `169.254.0.0/16`、`fe80::/10`（含 `169.254.169.254`）；
- 组播与广播 `224.0.0.0/4`、`ff00::/8`；
- 不在链路本地段里的云平台端点：`100.100.100.200`（阿里云）、`168.63.129.16`（Azure）、
  `192.0.0.192`（Oracle），以及 IPv6 的 `fd00:ec2::/32`、`fd20:ce::/32`、`fd00:c1::/32`、
  `fd00:42::/32`；
- **本机网卡自己的地址**（每秒刷新一次）：服务绑在 `0.0.0.0` 时，局域网地址与回环等价，
  不拦这一项等于绕过了上面所有条目；
- IPv4 映射/兼容写法的 IPv6（`::ffff:127.0.0.1`、`::ffff:7f00:1`）按其内嵌的 IPv4 判。

**私有网段（`10/8`、`172.16/12`、`192.168/16`、`fd00::/8` 其余部分）不拦**，因为内网域名与
fake-IP 代理都依赖它们；需要拦时用 `deniedDomains` 里的 IP 字面量。NAT64（`64:ff9b::/96`）
与 6to4（`2002::/16`）的内嵌 IPv4 不解码，需要时把前缀的译法写进 `deniedDomains`。

这些拒绝是**可恢复的**：本机地址检查只对没点名的规则生效，逐字写 `192.168.1.10:3000`
（或解析到它的那个名字）的条目直接跳过检查。所以 `*.corp.internal` 蒙不过去，
但把具体地址加进允许表就能用；这条也是「拦本机网卡地址」误伤的出口。

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
