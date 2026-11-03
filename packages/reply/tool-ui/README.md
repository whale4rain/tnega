# `@tnega/tool-ui`

注册模型可见工具 `show_ui`（依赖 `tools`）：用 `@tnega/a2ui` 校验 surface，返回一个简短确认。带按钮的 surface 设置 `concludesTurn`：本回合结束，用户的操作作为下一条用户消息到达。工具不碰文件、网络或进程，界面由客户端按 durable 的调用参数渲染。
