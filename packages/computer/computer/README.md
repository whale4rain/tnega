# `@tnega/computer`

电脑操作缝的 Service Definition：拥有 `ctx.computer` 与 `computer/*` 事件面，只承载词汇、错误码与 `act()` 的派发顺序。

- 观察（`windows` / `apps` / `screenshot` / `zoom` / `tree`）不发送任何输入。`apps` 列出能启动或有窗口的应用，没有列表的 Provider 默认抛 `COMPUTER_UNAVAILABLE`。`tree` 是窗口的无障碍树，行号给出元素令牌 `<snapshotId>:N`；同一窗口的新一次读取会让旧令牌失效（`COMPUTER_STALE_ELEMENT`）。没有树的 Provider 用默认实现抛 `COMPUTER_UNAVAILABLE`。
- 动作统一走 `act(action)`：先解析目标窗口（已关闭则 `COMPUTER_NO_WINDOW`），再派发 `computer/pre-action`（waterfall，可改写动作或设置 `deny`，但不能把动作移到另一个窗口），最后派发 `computer/action`（成功与失败都通知；监听器出错只记日志，不改变动作结果）。Provider 只实现 `runAction`，无法绕过策略与审计。
- 点击与滚动瞄准**元素或点二者之一**（`element` 或 `x, y`），`act()` 在派发前、以及策略改写后各检查一次，违反时抛 `TypeError`。坐标是目标窗口最近一次截图的像素，不是屏幕坐标。
- 动作：`click` / `type` / `key` / `scroll` / `drag` / `hover`（可以放进批量的“步骤”），以及 `menu`、`steps`、`launch`、`clipboard-read`、`clipboard-write`。剪贴板与启动不属于任何窗口。`assertAction` 在派发前与策略改写后检查动作的形状（瞄准互斥、菜单路径非空、批量步骤都在本窗口且最多 64 步）。
- `steps`：每一步都在任何一步执行前经过 `computer/pre-action`，任一步被拒则整批不执行；执行后每个已执行的步骤各发一次 `computer/action`。
- 结果的 `effect` 转述驱动对效果的判断，只有 `confirmed` 表示它回读确认过。
- 没有可用驱动时抛 `COMPUTER_UNAVAILABLE`，不回退到其他输入方式。

Provider：`@tnega/computer-cua`。Consumer：`@tnega/tool-computer`。取舍见 `docs/adr/0016-computer-use.md`。
