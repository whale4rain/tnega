# `@tnega/machine-pool`

`ctx.machinePool`：服务器上的 box，每个账号每个工作区一个。一次 run 要在 box 里工作时向池子要一个租约（`acquire`），结束时 `release`。

- **启动。** 池子经 `ctx.machines`（composition 层挑的 Provider）启动或恢复 box，为这次启动用 `ctx.accounts.createDevice` 发一个新的 daemon token，然后在 `ctx.daemons` 里等 daemon 连回来，把链接交给 run。daemon 在超时内没连上，box 被停掉、token 被撤销，`acquire` 以 `DAEMON_TIMEOUT` 失败。
- **一次性 token。** 从 checkpoint 恢复的 box 带着它原来的 token 连回来；新 box 带新 token。哪个连上就留哪个，另一个撤销，所以一个 box 任何时候只有一个有效 token；停掉 box 时撤销它。egress proxy 的 token 也一样。
- **空闲暂停与回收。** 最后一个租约结束后 `idlePauseMs`（默认 10 分钟）暂停 box；`reclaimAfterMs`（默认 7 天）没用过的 box 被停掉、行删掉（gVisor 挂的是成员自己的文件夹，文件夹保留）。
- **数量上限。** 一台主机最多同时跑 `maxRunning`（默认 3）个 box：再起一个时先暂停最久没用的空闲 box；都在忙就以 `POOL_FULL` 拒绝。
- **egress。** 给了 `egress` 时池子自己起 egress proxy，按 token 的 SHA-256 查每个 box 的策略：默认的包仓库与 GitHub，加上工作区 `.tnega/environment.toml` 里允许的主机。
- **每个 Project thread 一个 box（M4）。** `acquire` 的 `scope` 选工作区的哪一个 box：`''` 是人自己的 run，`thread:<id>` 是一个 Project thread；表的唯一键是 `(account_id, workspace, scope)`。`leasedLink` 给 thread 的 Agent 一个跨租约的链接：有调用时持有租约，空闲 `idleMs`（默认 60 秒）后放手，box 随后按 `idlePauseMs` 暂停；下一次调用重新拿租约，暂停的 box 恢复，换了连接就用新连接，通知监听跟着搬过去，旧连接关闭时 `onClose` 监听会听到（让暂停时的流结束而不是挂着）。`stopScope` 停掉一个 thread 的 box（Project 删除时）。
- **持久化。** `machine`（账号、工作区、Provider 的句柄、状态、spec 哈希、当前 daemon 设备、egress token 的哈希）与 `machine_session`（哪些 Session 用过这个 box）两张表，和账号在同一个 Postgres。服务器重启后从表里恢复 egress 策略，box 里的 daemon 自己重连。

测试：`test/machine-pool.test.ts` 用一个假的 Provider（启动后 daemon 立刻拨回）和 PGlite：复用、空闲暂停后带旧 token 恢复、数量上限、daemon 没连上、回收、egress 策略、每个 thread 一个 box、`leasedLink` 空闲后让 box 暂停并在下一次调用时恢复。真机验收在 `packages/runtime/test/boxes.e2e.test.ts`。
