# `@tnega/computer-remote`

`ctx.computer` 的远端 **Provider**：Computer use 跑在 Daemon 那台机器上，Runtime 经 `forwardService` 驱动它。

- 只有那台机器上的人用 `tnega daemon --computer` 打开时，Daemon 才宣告 `computer`；没宣告时挂载即失败（`COMPUTER_UNAVAILABLE`），不会回退到本机。
- `act` 仍由 `@tnega/computer` 的基类派发 `computer/pre-action` 与 `computer/action`：按应用分级（`computer-tiers`）与审批都在 Runtime 一侧，Daemon 只收到已经放行的动作。
- Daemon 一侧再检查一次动作的形状，并在终端里逐条显示动作；那里的人按 `p` 暂停（暂停时连截图都拒绝，`COMPUTER_DENIED`），再按一次恢复。
- 远端的 `ComputerError` 还原成本地的，带原来的 `code`；取消（`signal`）经 `$/cancel` 传到 Daemon。

```ts
await ctx.plugin(computerRemote, { link })
await ctx.plugin(computerTiers, { apps })
await ctx.plugin(toolComputer)
```
