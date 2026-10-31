# `@tnega/tool-computer`

电脑操作缝的 Consumer：模型可见的 `computer_*` 工具，只经 `ctx.computer` 访问本机。

| 工具 | 作用 |
| --- | --- |
| `computer_list_windows` | 列出窗口 id、应用与标题 |
| `computer_list_apps` | 列出本机的应用（运行中或仅安装）、它们的窗口与 `app_id`，可按 `query` 过滤 |
| `computer_open_app` | 按名称、命令、`app_id`（来自 `computer_list_apps`）或可执行文件全路径启动应用，可附 URL（只给名称时 URL 交给系统默认浏览器，给全路径时才交给该应用） |
| `computer_read_tree` | 以文本读窗口的无障碍树（可按 `query` 过滤、按 `since` 只看变化），可操作的行带 `[N]`，元素令牌是 `<snapshot>:N`；不带图片 |
| `computer_screenshot` | 截取一个窗口 |
| `computer_zoom` | 放大窗口截图的一块区域，看清小字或瞄准 |
| `computer_click` / `computer_type` / `computer_key` / `computer_scroll` / `computer_drag` | 动作，返回该窗口的新截图。点击与滚动要么给 `element_token`，要么给 `x, y`，二者互斥；输入与单键也可指向元素。优先用元素，树里没有的目标（画布、视频、自绘界面）才用像素 |
| `computer_hover` | 把**真实指针**停在窗口的一个点上（悬停菜单、提示框），窗口会被带到前台 |
| `computer_menu` | 按标签路径选原生菜单项，如 `["File", "Save As..."]`；标签缺失或歧义时不点任何东西 |
| `computer_steps` | 在一个窗口里一次执行多步（点击、输入、按键、滚动、拖动、悬停），遇到第一个失败即停，最后返回一张截图；策略逐步判断 |
| `computer_clipboard_read` / `computer_clipboard_write` | 读写剪贴板文本 |
| `computer_wait` | 等待后截图 |

每个工具声明 `grant`：对窗口的操作按拥有窗口的应用授权（`computer:app:<应用>`），列窗口、列应用、启动应用各有范围，剪贴板读写共用 `computer:clipboard`；审批宿主在用户允许后，本 Session 内同一范围不再询问。

只收文本的模型：`ToolComputerConfig.vision()` 返回 false 时（宿主按 Session 当前模型回答，每次截图前都问），不截图，动作与看图的工具只回一行窗口描述（窗口、应用、标题、尺寸），并指向 `computer_read_tree`；这时不计截图预算。

截图预算：配置文件里的 `computerMaxScreenshots`（经 `ToolComputerConfig.maxScreenshots`）限制一个 Session 能拿到的截图张数（截图、放大、等待与动作后的截图都算）。第一次用到时从 Session 里已有的 `computer_*` 结果数出之前的图片，所以重启不会把额度补满。用完后动作照常执行，只是不再附截图；`computer_screenshot` / `computer_zoom` / `computer_wait` 直接拒绝（`screenshot budget exhausted`），提示改用 `computer_read_tree`。不设即不限。

中断后能否直接重跑：只看不动的工具（`COMPUTER_OBSERVE_TOOLS`）与悬停是 `retry`，其余动作是 `confirm`（`COMPUTER_REPEATABLE_TOOLS`）。
