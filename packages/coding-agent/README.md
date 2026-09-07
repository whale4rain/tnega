# `@tnega/coding-agent`

工作区导向的 coding 会话打包插件。general 会话保留默认循环，coding 会话在 web
server 内按会话激活。

## 贡献

| 能力 | 说明 |
|---|---|
| plan 生成 | 用同一 LLM adapter 生成 JSON 计划（summary + items），稳健解析；`plan_execute_mark` / `plan_execute_result` 工具把执行状态写回 |
| skills | 扫描工作区 `.tnega/skills/<name>/SKILL.md`，提供 `skills_list` / `skill_read` |
| MCP | 读取工作区 `.tnega/mcp.json`，stdio 传输，工具名 `mcp__<server>__<tool>`，dispose 时清理子进程 |
| slash 命令 | `/plan`、`/mode` 等注册表，供 web 查询与执行 |

## 类型

`AgentKind` / `SessionMode` / `Plan` / `PlanItemStatus` / `SlashCommand`。会话元数据
`agentType: 'coding'` + `mode: 'auto' | 'plan' | 'execute'` 在创建/分叉时透传并持久化。

## 使用

```ts
import { createCodingAgentPlugin } from '@tnega/coding-agent'

await root.plugin(createCodingAgentPlugin({
  cwd: workspace,
  skills: true,
  mcp: true,
  planTools: true,
  mode: 'auto',
}))
```

coding agent definition 提供 coding 的 system prompt、plan 工具、skills、MCP 工具；
`CodingService` 暴露 `suggestCommand` 等供 web 的 slash-candidates 使用。

## 测试

`packages/coding-agent/test/`：plan 解析/回填、skills 加载、MCP 握手/调用/清理、
插件挂载工具、slash 注册。端到端走 `packages/cli/test/web.test.ts` 与
`apps/web` 前端集成。
