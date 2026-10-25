# `@tnega/tool-question`

注册独立模型工具 `ask_user_question`，依赖 `tools` 与 `userQuestions`。挂载配置 `{agentId?}` 为未带运行时身份的旧 Agent 提供会话身份；正常执行优先沿用 `ToolExecuteOptions.agentId`。

工具直接进入用户提问能力，不具有文件、网络或进程副作用；不自行路由用户答案。阻塞调用继承工具取消信号，不设置隐式提问期限。非阻塞调用只返回 pending 描述，回答由 composition 注入 steer/followup。
