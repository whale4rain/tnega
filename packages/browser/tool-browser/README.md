# `@tnega/tool-browser`

浏览器缝的 Consumer：模型可见的 `browser_*` 工具，工具集参照 Playwright MCP。只经 `ctx.browser` 进入能力，不认识具体 Provider。

- 观察：`browser_snapshot`、`browser_take_screenshot`（图片作为附件交给模型）、`browser_console_messages`、`browser_network_requests`。
- 动作：`browser_navigate`、`browser_navigate_back`、`browser_reload`、`browser_click`、`browser_hover`、`browser_type`、`browser_select_option`、`browser_press_key`、`browser_scroll`、`browser_wait_for`、`browser_resize`、`browser_evaluate`。

动作结果默认附上新的页面快照和本次动作期间出现的 console 错误，省去一次额外往返。`BROWSER_OBSERVE_TOOLS` / `BROWSER_ACT_TOOLS` 供 composition 层的权限规则使用。
