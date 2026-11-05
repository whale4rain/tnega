# `@tnega/machine`

Box 缝的 Service Definition：`ctx.machines`（`MachineService` / `MachineProvider`）。v2 里 Agent 在 server 上运行时，文件与命令在一个 box 里，由 box 中的 `tnega daemon` 提供（见 `docs/adr/0018-microvm-box-layer.md`、`docs/plans/v2-server-mvp.md` §4.4）。代码里叫 machine，因为 `ctx.box` 已是 Project 消息通道。

- `start(key, spec)` 可重复：同一 key 得到同一个 box，暂停的会被恢复；box 的 `specHash` 与新 spec 不同时以 `MACHINE_SPEC_CHANGED` 拒绝并给出旧 `ref`，由调用方先存工作再停掉重建。`pause` 保留内存与磁盘；`stop` 销毁；`status` 对已不存在的 box 回答 `missing`。
- `BoxSpec.isolation`：`container | gvisor | microvm`。给不了所要级别的 Provider 以 `SANDBOX_UNAVAILABLE` 失败，不降级。
- `BoxSpec.network`：`egress`（只能经 egress proxy 出网，box 带自己的 proxy token 与 CA）、`open`（显式放开）、`none`（只有 daemon 连 server）。
- `validateBoxSpec` 与 `boxEnvironment` 让所有 Provider 拒绝同样的东西、给 box 同样的环境变量；`spec.env` 不能覆盖 daemon 与 proxy 的变量。

Provider 见 `@tnega/machine-e2b`；选哪个属于 composition 层。
