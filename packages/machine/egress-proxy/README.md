# `@tnega/egress-proxy`

box 唯一的出口，建在 `@tnega/sandbox-network-proxy` 上。每个 box（及其每个阶段：setup、agent）是一个带自己 token 的客户端（`Proxy-Authorization: Basic box:<token>`），按自己的策略放行主机。

- 需要 key 的主机：proxy 用自己的 CA（`x509.ts`，ECDSA P-256）为该主机签证书、终止 box 的 TLS，校验真实主机证书后再加上 key 转发；`Host` 与隧道主机不一致回 421，校验不过回 502，都不发 key。只在 443 端口、只对 HTTPS。
- 其他放行的主机：普通 CONNECT 隧道，box 看到的是真实证书。
- 开源 E2B runtime 不支持自带 SOCKS 出口（BYOP）和请求头注入规则，所以 key 由我们的 proxy 加，box 里从来没有 key。
