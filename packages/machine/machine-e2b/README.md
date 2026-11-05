# `@tnega/machine-e2b`

`ctx.machines` 的 Provider：box 是 E2B runtime 上的 Firecracker microVM，自托管的开源 runtime 或 E2B 云，按 API URL 区分。box 的生命周期直接调用 E2B REST API（`X-API-KEY`）；在 box 里起 daemon 和构建模板用 E2B 的 JS SDK（`e2b`）。

- machine key 与 `specHash` 写在沙箱 metadata（`tnega_machine`、`tnega_spec_hash`）里；`start` 先按 key 查 running / paused 的沙箱，暂停的经 `/connect` 恢复；新建时的 `Idempotency-Key` 是 key 与这个 box 的一次性 daemon token 的哈希，同一个 box 的重试只建一个沙箱，下一个 box（新 token）不会被重放成已删除的那个。
- daemon 不是模板的启动命令：E2B 只在构建模板时跑一次启动命令并做快照，它拿不到每个 box 自己的 token。每次 `start` 之后经 E2B 的命令 API 以 root 跑 `LAUNCH_COMMAND`（daemon 已在跑就什么都不做，否则 `setsid -f` 起 `deploy/e2b/template/start.sh`），daemon 的设置只在这一条命令的环境里；沙箱自身的环境变量是空的，agent 的命令继承不到 token。
- `buildBoxTemplate` 用 E2B 的模板构建 v2 从 `deploy/e2b/template/e2b.Dockerfile` 构建模板（旧的 `e2b template build` 已于 2026-08-01 停用）。
- 沙箱建成 `autoPause`：超时后暂停而不是销毁，server 忘了暂停也不丢东西。
- 网络在 VM 外由 E2B 防火墙执行：`egress` 只放行 egress proxy 与 server（`denyOut 0.0.0.0/0`），`none` 只放行 server，`open` 是 `allow_internet_access`。防火墙里只放 IP，并设 `dnsServers: []`：E2B 只要 `allowOut` 里有域名就会放行 8.8.8.8，DNS 查询可以绕过 proxy 带出数据。server 的域名在启动时解析成 IPv4，经 `TNEGA_HOSTS` 写进 box 的 `/etc/hosts`；其他域名都由 egress proxy 解析。server 换了 IP 后，旧 box 要重建。
- 每次 API 调用最多 60 秒（`requestTimeoutMs`）。
- CPU 与内存由模板决定，`BoxSpec.resources` 不下发。
- API URL 必须是 https（http 只允许本机），以免 key 明文传出。

测试：`test/machine-e2b.test.ts` 用一个假的 E2B API；`test/machine-e2b.e2e.test.ts` 属宿主层，设置 `TNEGA_E2B_API_URL`、`TNEGA_E2B_API_KEY`、`TNEGA_E2B_TEMPLATE` 后才运行。模板见 `deploy/e2b/template/`。
