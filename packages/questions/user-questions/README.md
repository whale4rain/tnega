# `@tnega/user-questions`

独立的用户提问能力：`ctx.userQuestions` 管理问题、答案、等待和持久化。模型工具由 `@tnega/tool-question` 注册；Web、CLI 或其他界面通过 composition 提交答案。

挂载 `userQuestions` 时提供 `resolveSession(agentId)`，只为精确的会话所有者返回 `SessionLog`。`ask(input, { agentId, callId?, signal? })` 接受 `blocking` 或 `nonblocking` 模式。阻塞模式等待答案，取消和插件卸载会解除等待；非阻塞模式立即返回 `requestId`。问题支持单选、多选、自由文本以及 `optional:true` 的跳过；问题文字和选项都可以为空，但问题必须有唯一稳定 ID。

`listPending(agentId)` 加载会话的待回答问题；`answer(requestId, answers, {agentId})` 校验所有者、问题 ID、选项及必答约束。每个答案项为 `{questionId, selected?: string[], text?: string}`，选项采用原标签。第一个合法提交获胜。成功提交后触发 `user-questions/answered`，其中含原始问题和答案。composition 将非阻塞答案通过 `formatQuestionAnswer` 格式化后，路由到正在运行 Agent 的 steer 队列，或已结束 Agent 的 followup 队列；阻塞答案只返回给原工具调用，避免重复注入。

持久化使用 `question/opened`、`question/answered`、`question/cancelled` 的独立 Session meta，不改变模型可见历史或会话配置。`pendingQuestionsFromEvents` 为界面提供纯解析入口。重启后的非阻塞问题仍可回答；没有运行时等待者的阻塞问题会取消，不能以孤立问题复活旧工具调用。

Web composition 通过 `deliverNonblocking` 在结算前写入 durable steer；首次合法答案先记录为 `question/submitted`，投递失败后的重试沿用它。投递按请求 ID 幂等，已有 inbox 插入不重复写入，随后才记录 `question/answered`。

参考 DSH 的稳定问题 ID、结构化答案、取消及 first-answer-wins；非阻塞队列是本项目的扩展。非阻塞问题仅适合不妨碍继续工作的建议，必需决定应使用阻塞模式。
