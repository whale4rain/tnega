# `@tnega/computer-tiers`

电脑操作缝上的策略插件：按应用限制 Agent 能做到哪一步。只依赖 Service Definition `@tnega/computer`，挂在 `computer/pre-action` 上，被拒的动作以 `COMPUTER_DENIED` 结束，不会到达 Provider。

| 级别 | 允许 |
| --- | --- |
| `look` | 只看：截图、读树。该应用窗口里的一切动作都拒绝 |
| `click` | 点击、滚动、悬停、菜单；不能输入、按键或拖动 |
| `full` | 不限（未列出的应用默认如此） |

- 配置：`apps`（应用名 → 级别，可以是每次动作都读的函数）与 `fallback`（未列出应用的级别，默认 `full`）。宿主从设置的 `computerApps` 传入。
- 应用名不区分大小写，忽略目录与 `.exe` / `.app`：`Notepad`、`notepad.exe`、`C:\Windows\notepad.exe` 是同一个应用。窗口按进程名或 `ctx.computer.apps()` 里的显示名（如 `Google Chrome` 对 `chrome.exe`）匹配；显示名每次动作都现查，不缓存（进程号可能被同名程序的另一份安装复用）。设了上限、进程名不匹配、应用列表里又找不到所属应用（或读不到列表）时拒绝动作（fail closed），提示把进程名加进 App limits。
- 批量动作（`steps`）逐步判断，一步被拒整批不执行。剪贴板不属于任何应用，启动应用不是对它的输入（附带 URL 只是导航），都不分级。
- 拒绝说明写明应用、级别与允许的范围，并告诉模型不要绕过、需要时去问用户。

取舍见 `docs/adr/0016-computer-use.md`「默认全放行、风险由 Agent 标出、按应用分级」。
