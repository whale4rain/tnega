# `@tnega/machine-e2b`

`ctx.machines` 的 Provider：box 是 E2B runtime 上的 Firecracker microVM，自托管的开源 runtime 或 E2B 云，按 API URL 区分。直接调用 E2B REST API（`X-API-KEY`），不依赖 SDK。

- machine key 与 `specHash` 写在沙箱 metadata（`tnega_machine`、`tnega_spec_hash`）里；`start` 先按 key 查 running / paused 的沙箱，暂停的经 `/connect` 恢复；新建时把 key 作 `Idempotency-Key`。
- 沙箱建成 `autoPause`：超时后暂停而不是销毁，server 忘了暂停也不丢东西。
- 网络在 VM 外由 E2B 防火墙执行：`egress` 只放行 egress proxy 与 server（`denyOut 0.0.0.0/0`），`none` 只放行 server，`open` 是 `allow_internet_access`。防火墙里只放 IP，并设 `dnsServers: []`：E2B 只要 `allowOut` 里有域名就会放行 8.8.8.8，DNS 查询可以绕过 proxy 带出数据。server 的域名在启动时解析成 IPv4，经 `TNEGA_HOSTS` 写进 box 的 `/etc/hosts`；其他域名都由 egress proxy 解析。server 换了 IP 后，旧 box 要重建。
- 每次 API 调用最多 60 秒（`requestTimeoutMs`）。
- CPU 与内存由模板决定，`BoxSpec.resources` 不下发。
- API URL 必须是 https（http 只允许本机），以免 key 明文传出。

测试：`test/machine-e2b.test.ts` 用一个假的 E2B API；`test/machine-e2b.e2e.test.ts` 属宿主层，设置 `TNEGA_E2B_API_URL`、`TNEGA_E2B_API_KEY`、`TNEGA_E2B_TEMPLATE` 后才运行。模板见 `deploy/e2b/template/`。
