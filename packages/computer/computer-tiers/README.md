# `@tnega/computer-tiers`

电脑操作缝上的策略插件：按应用限制 Agent 能做到哪一步。只依赖 Service Definition `@tnega/computer`，挂在 `computer/pre-action` 上，被拒的动作以 `COMPUTER_DENIED` 结束，不会到达 Provider。

| 级别 | 允许 |
| --- | --- |
| `look` | 只看：截图、读树。该应用里的一切动作都拒绝；不带 URL 的启动除外 |
| `click` | 点击、滚动、悬停、菜单；不能输入、按键或拖动 |
| `full` | 不限（未列出的应用默认如此） |

- 配置：`apps`（应用名 → 级别，可以是每次动作都读的函数）与 `fallback`（未列出应用的级别，默认 `full`）。宿主从设置的 `computerApps` 传入。
- 应用名不区分大小写，忽略目录与 `.exe` / `.app`：`Notepad`、`notepad.exe`、`C:\Windows\notepad.exe` 是同一个应用。
- 批量动作（`steps`）逐步判断，一步被拒整批不执行。剪贴板不属于任何应用，不分级。
- 拒绝说明写明应用、级别与允许的范围，并告诉模型不要绕过、需要时去问用户。

取舍见 `docs/adr/0016-computer-use.md`「默认全放行、风险由 Agent 标出、按应用分级」。
