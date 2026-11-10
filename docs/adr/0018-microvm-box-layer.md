# 0018 v2 的 box 用 microVM：E2B 开源 runtime 作底层，不做 Docker box

> 状态：当前
> 取代关系：取代 `docs/plans/v2-plan.md` 里「First box: Docker or Podman; microVM later」
> 当前实现：`machine-e2b`（microVM）与 `machine-gvisor`（没有 KVM 的主机，见文末补充）；设计见 `docs/plans/v2-server-mvp.md` §4.4、§4.7，分包见 `docs/plans/v2-package-changes.md` P8

日期：2026-11-05

## 背景

v2 里 tnega server 为每个线程 / 会话启动一个 box（代码里叫 machine，`ctx.machines`）：仓库在里面，Agent 的命令、文件、终端都在里面执行，`tnega daemon` 在里面向 server 拨出连接。Agent loop（headless runtime）留在 server。

原计划先做 Docker box、以后再加 microVM。负责人（2026-11-05）否决了 Docker box：冷启动约一秒太慢，隔离也只到共享内核。要求：microVM、开源、复用现成的一层，而不是自己造 VM 平台。

## 候选

| 候选 | 是什么 | 结论 |
|---|---|---|
| E2B runtime（`e2b-dev/runtime`，Apache-2.0） | 完整的 box 服务：API、每台主机的 orchestrator、VM 内 agent、模板构建；Firecracker，从快照恢复而不是开机；空闲自动暂停并保留内存与磁盘；nftables 出口白名单；JS SDK。E2B 云跑的就是这份代码 | **采用** |
| Agent Substrate（`agent-substrate/substrate`，Google，AX 的底层） | 把大量 agent actor 复用到少量 worker 上，空闲 actor 快照出内存；Cloud Hypervisor 或 gVisor；恢复 <400 ms；出口网关在 box 外注入凭据 | 需要 Kubernetes，自称很早期（pre-1.0）；留作托管大规模部署的后续 Provider |
| Google AX（`google/ax`） | 完整的 Agent 编排器（Task / Workspace / Model），跑在 Substrate 上 | 不采用：它会取代 tnega server 自己的 Agent loop 与 Session 日志 |
| microsandbox（libkrun） | 嵌入式库，<100 ms 启动，TypeScript SDK，Linux / macOS / Windows | Beta，只管一台主机，跨主机调度要自己做；可作为以后本机 microVM box 的候选 |
| Firecracker / Cloud Hypervisor / Kata 直接用 | 虚拟机监视器或运行时 | 暂停、恢复、镜像、网络、调度都要自己做，不采用 |

## 决策

决策已定，尚未实现（2026-11-05）。

- **box 只用 microVM，不做 Docker Provider。** 第一个 Provider 是 `machine-e2b`，对接自托管的 E2B runtime；同一个 Provider 换一个 URL 就能对接 E2B 云。
- **`BoxSpec` 带 `isolation` 字段**（`"microvm"` 起步）。Provider 给不了要求的隔离级别时以 `SANDBOX_UNAVAILABLE` 失败，不回退。
- **box 里仍跑 `tnega daemon`**：M1 的协议、终端与可续传 stream 不变。E2B 自带的 `envd` 只用于启动 daemon，文件与命令都走 daemon。
- **钥匙不进 box**：模型调用在 server；git token 与 API key 由我们的 egress proxy 注入。E2B 的出口规则只放行这个 proxy。
- **暂停即睡眠**：box 空闲后暂停（内存与进程保留），下一条消息恢复。headless 的生命周期与默认值见 `v2-server-mvp.md` §4.7。

## 后果

- 主机需要 Linux + KVM（独立服务器或支持嵌套虚拟化的云主机）；很多便宜 VPS 与 Mac 不行。本机模式不受影响：不用 box，仍是今天的本地沙箱。
- E2B runtime 是多服务的 Go 系统；我们部署、不修改。它的单机包官方定位是评估用，生产形态是 GCP Terraform 或 Kubernetes。
- 自托管的 compose 不再挂 Docker socket，少了 Docker Engine 这条控制宿主的路径；server 只持有作用于自己沙箱的 E2B API key。

## 验证

实现 P8 时用宿主层测试（`*.e2e.test.ts`，需要装好 E2B runtime 的 KVM 主机）证明：

- **启动与幂等**：同一个 machine id 两次 `start` 得到同一个 box；`spec_hash` 变化时旧 box 先存工作包再销毁，新 box 从新模板创建。
- **暂停与恢复**：box 里起一个后台进程并写一个未提交文件，`pause` 后再 `start`，进程仍在、文件仍在、`tnega daemon` 重新连上。
- **只经 proxy 出网**：box 里直连任意外部地址失败；经 proxy 访问白名单主机成功，非白名单主机被拒；box 内环境变量与磁盘里找不到模型 key 和 git token。
- **fail closed**：要求的 `isolation` 给不了、或出口规则设不上时，`start` 以 `SANDBOX_UNAVAILABLE` 失败。
- **无 KVM**：在没有 `/dev/kvm` 的主机上，部署检查给出明确报错，而不是退回容器。

## 补充（2026-11-10）：没有 KVM 的主机用 gVisor

第一台云主机（阿里云 ECS，本身是 KVM 客户机）没有 `/dev/kvm`，也没有嵌套虚拟化：Firecracker、自托管的 E2B runtime 和 microsandbox 都跑不起来（issue #85）。补充决定：

- `microvm` 仍是首选级别；`gvisor` 成为**允许**的级别，但必须由 composition 层按主机显式选择（运维为这台主机选 `machine-gvisor`，server 为它的 box 要 `isolation: "gvisor"`），**绝不是** Provider 内部的回退。要 `microvm` 的 box 在 gVisor 主机上仍以 `SANDBOX_UNAVAILABLE` 失败。
- `machine-gvisor`：gVisor 的 `systrap` 平台不需要 KVM。它不是虚拟机，但有真正的系统调用边界（用户态内核）和自己的网络命名空间；出口由主机上的 nftables 只放行 egress proxy 与 server，规则设不上就不启动。
- E2B 仍是有 KVM 的主机和 E2B 云的 Provider。
- 部署检查（`probeGvisorHost`，`pnpm try:boxes gvisor`）说清楚缺什么、有没有 `/dev/kvm`，而不是悄悄退回容器。
