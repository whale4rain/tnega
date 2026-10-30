# `@tnega/computer-cua`

电脑操作缝的 Provider：经 MCP stdio 启动 [cua-driver](https://cua.ai/docs/cua-driver)（`cua-driver mcp`），把 `ctx.computer` 的调用映射到它的工具（`list_windows`、`get_window_state`、`click`、`type_text`、`press_key` / `hotkey`、`scroll`、`drag`、`zoom`、`launch_app`）。

- 驱动在第一次调用时启动，随插件 dispose 停止；启动失败不缓存，装好驱动后下一次调用即可用。
- 查找顺序：配置 `driverPath` → `TNEGA_CUA_DRIVER` → PATH → 安装器默认目录（Windows `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin`，其他 `~/.local/bin`）。找不到时抛 `COMPUTER_UNAVAILABLE` 并附安装命令。
- 默认后台投递；驱动报 `background_unavailable` 时以前台模式重试一次。对从未截图的窗口，先截一次图再发像素输入（驱动要求）。
- 启动前执行一次 `cua-driver telemetry disable`。
- 子进程继承宿主的完整环境（`DISPLAY`、`DBUS_SESSION_BUS_ADDRESS` 等桌面会话变量）。
