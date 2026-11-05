# 0018 v2 的 box 用 microVM：E2B 开源 runtime 作底层，不做 Docker box

> 状态：已决定，尚未实现
> 取代关系：取代 `docs/plans/v2-plan.md` 里「First box: Docker or Podman; microVM later」
> 当前实现：尚未实现；设计见 `docs/plans/v2-server-mvp.md` §4.4、§4.7，分包见 `docs/plans/v2-package-changes.md` P8

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

- **box 只用 microVM，不做 Docker Provider。** 第一个 Provider 是 `machine-e2b`，对接自托管的 E2B runtime；同一个 Provider 换一个 URL 就能对接 E2B 云。
- **`BoxSpec` 带 `isolation` 字段**（`"microvm"` 起步）。Provider 给不了要求的隔离级别时以 `SANDBOX_UNAVAILABLE` 失败，不回退。
- **box 里仍跑 `tnega daemon`**：M1 的协议、终端与可续传 stream 不变。E2B 自带的 `envd` 只用于启动 daemon，文件与命令都走 daemon。
- **钥匙不进 box**：模型调用在 server；git token 与 API key 由我们的 egress proxy 注入。E2B 的出口规则只放行这个 proxy。
- **暂停即睡眠**：box 空闲后暂停（内存与进程保留），下一条消息恢复。headless 的生命周期与默认值见 `v2-server-mvp.md` §4.7。

## 代价

- 主机需要 Linux + KVM（独立服务器或支持嵌套虚拟化的云主机）；很多便宜 VPS 与 Mac 不行。本机模式不受影响：不用 box，仍是今天的本地沙箱。
- E2B runtime 是多服务的 Go 系统；我们部署、不修改。它的单机包官方定位是评估用，生产形态是 GCP Terraform 或 Kubernetes。
- 自托管的 compose 不再挂 Docker socket，server 也就不再拿到宿主 root。
