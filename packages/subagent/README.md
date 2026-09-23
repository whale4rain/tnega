# Subagent seam

`@tnega/subagent` 定义 `ctx.subagents`，`@tnega/subagent-local` 提供工作区内的实现，
`@tnega/tool-subagent` 暴露 `spawn_subagent`、`list_subagent`、`send_agent_message`。
Provider 与 Consumer 只依赖 Definition，组合层选择 Provider。

每个子代理保存在 `.tnega/subagents/<id>/session.jsonl`，同目录有 `artifacts/`。
`spawn` 从空对话开始；`fork` 在新 Session 的 checkpoint 中复制父 Session 已完成的 turn。
两种模式均与父 Agent 共享 Workspace 文件，写文件时应分配不重叠的范围。

父子消息写入收件方的 durable inbox。仅相邻父子可互发消息。子代理结束时，
Provider 把摘要写入父 Agent inbox；父 Agent 通过 `list_subagent` 查询运行状态，
可传 `wait_ms` 做最长 30 秒的有界等待，不订阅子代理事件。
子代理可在进程重启后按 Session 恢复。默认最多 3 个并行子代理、嵌套深度 2；
Shell 和网络工具按子代理创建时的权限拦截，恢复不会扩大权限。
