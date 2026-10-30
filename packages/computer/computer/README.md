# `@tnega/computer`

电脑操作缝的 Service Definition：拥有 `ctx.computer` 与 `computer/*` 事件面，只承载词汇、错误码与 `act()` 的派发顺序。

- 观察（`windows` / `screenshot` / `zoom`）不发送任何输入。
- 动作统一走 `act(action)`：先解析目标窗口（已关闭则 `COMPUTER_NO_WINDOW`），再派发 `computer/pre-action`（waterfall，可改写动作或设置 `deny`，但不能把动作移到另一个窗口），最后派发 `computer/action`（成功与失败都通知；监听器出错只记日志，不改变动作结果）。Provider 只实现 `runAction`，无法绕过策略与审计。
- 坐标是目标窗口最近一次截图的像素，不是屏幕坐标。
- 没有可用驱动时抛 `COMPUTER_UNAVAILABLE`，不回退到其他输入方式。

Provider：`@tnega/computer-cua`。Consumer：`@tnega/tool-computer`。取舍见 `docs/adr/0016-computer-use.md`。
