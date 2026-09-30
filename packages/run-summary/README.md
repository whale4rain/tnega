# `@tnega/run-summary`

独立的 Agent Run 展示插件。通过 `ctx.plugin(runSummary)` 挂载；Fiber dispose 时自动撤销监听。

成功结束的 Agent Run 在 durable `turn/end` 后、`run/end` Stream Event 前，保存
`meta`（`kind: 'run/summary'`、`turn`、`summary`、`sourceMessageId`）。Summary 使用该
Agent Run 最后一条完整且无工具调用的 assistant 回复，不额外调用模型。

取消、错误、步数或轮数耗尽、截断以及没有最终回复的 Agent Run 不生成 Summary。
元数据只影响展示，不替换 Session 消息，也不改变模型可见历史或持久化格式。

Web Timeline 保留最终回复，把之前的过程默认折叠；提示、错误和文件修改摘要保持可见。
旧 Session 在明确成功的 durable `turn/end` 后可从最终回复重建同样的展示。
