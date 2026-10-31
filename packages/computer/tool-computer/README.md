# `@tnega/tool-computer`

电脑操作缝的 Consumer：模型可见的 `computer_*` 工具，只经 `ctx.computer` 访问本机。

| 工具 | 作用 |
| --- | --- |
| `computer_list_windows` | 列出窗口 id、应用与标题 |
| `computer_open_app` | 按名称、命令或可执行文件全路径启动应用，可附 URL（只给名称时 URL 交给系统默认浏览器，给全路径时才交给该应用） |
| `computer_screenshot` | 截取一个窗口 |
| `computer_zoom` | 放大窗口截图的一块区域，看清小字或瞄准 |
| `computer_click` / `computer_type` / `computer_key` / `computer_scroll` / `computer_drag` | 动作，返回该窗口的新截图 |
| `computer_wait` | 等待后截图 |

每个工具声明 `grant`：对窗口的操作按拥有窗口的应用授权（`computer:app:<应用>`），列窗口与启动应用各有范围；审批宿主在用户允许后，本 Session 内同一范围不再询问。
