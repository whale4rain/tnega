# `@tnega/computer-cua`

电脑操作缝的 Provider：经 MCP stdio 启动 [cua-driver](https://cua.ai/docs/cua-driver)（`cua-driver mcp`），把 `ctx.computer` 的调用映射到它的工具（`list_windows`、`get_window_state`、`click`、`type_text`、`press_key` / `hotkey`、`scroll`、`drag`、`zoom`、`launch_app`、`move_cursor`、`invoke_menu`、`run_steps`、`clipboard_read` / `clipboard_write`、`list_apps`）。

- 驱动在第一次调用时启动，随插件 dispose 停止；启动失败不缓存，装好驱动后下一次调用即可用。
- 查找顺序：配置 `driverPath` → `TNEGA_CUA_DRIVER` → PATH → 安装器默认目录（Windows `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin`，其他 `~/.local/bin`）。找不到时抛 `COMPUTER_UNAVAILABLE` 并附安装命令。
- 默认后台投递；驱动在送出前就拒绝该事件类型（`background_unavailable`）时，以前台模式重试一次。驱动投递了却无法回读、自报效果不可验证时（`effect: unverifiable` + `escalation.target: foreground`）**不重发**：第一次可能已经生效，重发就是把一个字符打成两个；结果说明里提示先看截图再决定是否重做。对从未截图的窗口，先截一次图再发像素输入（驱动要求）。
- 元素通道：`tree` 用 `get_window_state` 且 `include_screenshot: false`（只读树，便宜），原样转发 `query` / `since` / `max_elements` / `max_depth`。带元素的动作发 `element_token`、不发 `x/y`，也不需要先截图。只截图的读取（`include_accessibility_tree: false`）不会让令牌失效；新的树读取会。令牌过期时驱动拒绝（`stale_element_token`），Provider 报 `COMPUTER_STALE_ELEMENT` 并提示重读，不自动重试。
- 启动驱动时设置 `CUA_DRIVER_RS_TELEMETRY_ENABLED=false`，关掉这一进程的遥测（不改用户保存的选择）。
- 截图长边默认 1024（可配 `maxImageDimension`）：3200×1904 窗口下 1568 是 724 KiB / 约 950 图片 token，1024 是 402 KiB / 约 400 token，而摘要页级别的密集文字在 1024 仍可读。小字靠 `computer_zoom` 而不是放大整图。
- `launch` 动作：应用名里没有路径分隔符时用 `name`（+ `urls`，URL 由驱动交给系统默认浏览器）；给了带路径的可执行文件时改用 `path`，并把 URL 当 `additional_arguments` 传给该应用，所以能指定用 Chrome 而不是默认浏览器打开。
- 子进程继承宿主的完整环境（`DISPLAY`、`DBUS_SESSION_BUS_ADDRESS` 等桌面会话变量）。
- 窗口最小化时驱动截不到图（图标化窗口没有可渲染内容）；Provider 先 `bring_to_front` 把窗口恢复再截一次，恢复不了才报错。

## 坐标（Windows 实测量）

模型给的点是**该窗口最近一次截图的像素**，驱动自己换算，调用方不需要做任何 DPI 转换。3200×1904 的窗口、220% 页面缩放的 Chrome（dpr 2.2）上测出的关系：

- 截图是全窗口缩小版（1568×933），驱动按 `窗口物理宽 / 截图像素宽` = 2.0408 换成物理坐标，再除 dpr 落到页面 CSS 坐标。
- 图片与页面 CSS 几乎 1:1：`css_x = 0.9276 × image_x`，`css_y = 0.9276 × image_y − 79.6`；后一项是窗口顶部浏览器界面的高度（标签栏 + 地址栏，约 175 物理像素）。截图含浏览器界面，所以 y 从窗口顶端算起。
- 35 个网格点拟合残差 ≤ 0.6 CSS 像素，12 个 300×60 的目标全部命中：单次像素点击精度约 ±1 图片像素。
- 截图给出的是窗口自身坐标系，与屏幕位置、多显示器无关；窗口换了显示器缩放不同导致偏移时，驱动返回的说明里会给出它实际投递的物理坐标。
- 悬停：窗口范围的 `move_cursor` 只动驱动的叠加光标，应用看不到；所以先 `bring_to_front`，再按窗口在桌面上的位置与最近一次截图的尺寸把像素换算成桌面坐标（`desktopPoint`），以 `target: {kind: "desktop"}` 移动真实指针。
- 批量：`run_steps` 带 `foreground_fallback: true`，后台被拒的步骤由驱动单步前台重试；Provider 不整批重发。结果逐步转成 `steps`，说明里写明第几步失败、之前执行了几步。
- 应用：`list_apps` 只保留有 `bundle_id`、`launch_path` 或窗口的条目；`launch` 带 `id` 时，按上一次列表里的 `bundle_id` / `launch_path` 启动。
