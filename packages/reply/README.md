# `packages/reply/`

回复域：让 Agent 在答复里交给用户的不只是文字。

- `a2ui`：Agent 渲染界面的词汇（A2UI 基础组件目录的一个子集、一次性发送的 surface、按钮回传的 action 格式）。纯 TypeScript，`show_ui` 用它校验，客户端用它渲染。
- `tool-ui`：模型可见的 `show_ui`。带按钮的 surface 结束本回合，用户按下按钮后以一条 `[ui-action] {...}` 用户消息回到 Agent。
- `tool-send-file`：模型可见的 `send_file`。把工作区文件放进答复：图片内联显示，其他文件是可在工作台打开的文件卡。

两个工具都只记录 durable 的工具调用，不把文件内容读进模型上下文；客户端从工作区读字节、从调用参数渲染界面，所以重放与实时一致。由 `packages/runtime` 的 `reply` 能力挂载，宿主（Web / 桌面）打开它；`tnega run` 没有界面，不挂。
