# `@tnega/machine-gvisor`

`ctx.machines` 的 Provider：box 是 gVisor 沙箱，给**没有 KVM** 的主机用（不支持嵌套虚拟化的云主机，如 issue #85 里的阿里云 ECS）。不是虚拟机：box 的系统调用由 gVisor 的用户态内核（sentry）处理，网络是 sentry 里的 netstack，外面再有主机上的网络命名空间和 nftables 规则。

- **隔离级别。** 接受 `container` 与 `gvisor`；要 `microvm` 的 box 以 `SANDBOX_UNAVAILABLE` 拒绝。它从不降级：一台主机用不用 gVisor 由 composition 层按主机决定（运维显式选择），Provider 自己不会退到 gVisor。
- **文件系统。** 模板的根文件系统（`deploy/gvisor/build-rootfs.sh` 构建到 `/var/lib/tnega/templates/<name>/rootfs`）是所有 box 共用、没人写的下层；每个 box 的写入进它自己的 overlay（`--overlay2 root:<box>/upper`）；工作区是主机上的一个目录，挂到 `spec.workspacePath`。主机的 `/home` 和 store 目录不在 box 里。
- **网络。** 每个 box 一个命名空间和一对 veth（10.88.0.0/16 里的 /30）。`egress` 与 `none` 只放行 egress proxy 和 daemon 要连的 server，规则挂在主机这一端的 veth 上（`input` 与 `forward` 两条链），box 里的命令绕不过去；`open` 是显式放开。box 没有 DNS：server 的域名启动时解析好经 `TNEGA_HOSTS` 写进 `/etc/hosts`，与 E2B 一样。规则设不上时 `start` 以 `SANDBOX_UNAVAILABLE` 失败，什么都不运行，建了一半的命名空间也会删掉。
- **生命周期。** `start(key, spec)` 按 key 幂等，记录在 `/var/lib/tnega/machines/records/<id>.json`；`specHash` 不同以 `MACHINE_SPEC_CHANGED` 拒绝。`pause` 先试 gVisor 的 checkpoint（保留内存与进程），不行就停掉沙箱、保留工作区（冷暂停）；下一次 `start` 恢复 checkpoint，或在保留的工作区上冷启动。`stop` 删除沙箱、overlay 与工作区。
- **资源。** cgroup v2 限制来自 `BoxSpec.resources`，默认 1.5 个 CPU、768 MiB、512 个进程，一个 box 拖不垮 2 vCPU / 3.6 GiB 的主机。
- daemon 在 sentry 里以 uid 0 运行，但没有任何 capability、`noNewPrivileges`：它只能写自己拥有的 `/etc/hosts` 与 CA 文件。命令以单独用户运行是 M3 的已知待办（与 E2B 相同）。

主机要求：root、`runsc`（连同 release 包里的 `gvisor-bin/` 目录，只拷 `runsc` 一个文件会让每个沙箱都起不来）、`ip`、`nft`、cgroup v2。`probeGvisorHost()` 检查这些并报告 `/dev/kvm` 是否存在；`pnpm try:boxes gvisor` 先做这个检查，再实际起停一个 box。

测试：`test/machine-gvisor.test.ts` 用一个假的 runsc / ip / nft，覆盖 OCI 配置与 runsc 参数、规则先于沙箱、规则失败时 fail closed、`microvm` 被拒、没有 runsc 时 `MACHINE_UNAVAILABLE` 且什么都不建、幂等与 `MACHINE_SPEC_CHANGED`、checkpoint 与冷暂停。`test/machine-gvisor.e2e.test.ts` 属宿主层：需要 root、gVisor 和用 `build-rootfs.sh` 建好的模板，设置 `TNEGA_GVISOR_TEMPLATE` 后才运行。
