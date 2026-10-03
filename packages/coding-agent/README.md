# `@tnega/coding-agent`

工作区导向的 coding 会话打包插件。general 会话保留默认循环，coding 会话在 web
server 内按会话激活。

## 贡献

| 能力 | 说明 |
|---|---|
| plan 生成 | 用同一 LLM adapter 生成 JSON 计划（summary + items）；Plan 模式只产出计划，不执行 |
| skills | 扫描用户 `~/.tnega/skills` 和工作区 `.tnega/skills/<name>/SKILL.md`，提供 `skills_list` / `skill_read` |
| MCP | 读取工作区 `.tnega/mcp.json`，stdio 传输，工具名 `mcp__<server>__<tool>`，dispose 时清理子进程 |
| slash 命令 | `/plan`、`/goal`、`/mode` 等注册表，供 web 查询与执行 |

## 类型

`AgentKind` / `SessionMode` / `Plan` / `PlanItemStatus` / `SlashCommand`。会话元数据
`agentType: 'coding'` + `mode: 'auto' | 'plan' | 'goal'` 在创建/分叉时透传并持久化。

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

## 内置 skills

`builtin-skills/` 是十二份离线内置文档的唯一来源，构建时嵌入 Node / 桌面
bundle，不依赖源码路径或联网下载。`installBuiltinSkills()` 按 `TNEGA_HOME`
（默认 `~/.tnega`）安装缺失文件，原子发布且永不覆盖用户修改；升级仅补充缺失
skill。用户可把自定义目录放在 home 的 `skills/` 下；工作区同名 skill 优先。

`skillTools` 插件为 general、coding 与 Project 共用，提供 `skills_list` /
`skill_read`、`skill_create`、`skill_install` 和按需加载的触发说明索引，dispose 会移除工具和提示词监听。
`createCodingAgentPlugin` 会复用同一工作区已有的 skills 插件。旧会话保留原
system persona 时，通过工具说明提供索引（PTC 使用 `run_code`），不改写历史。低层 `listSkills` /
`readSkill` 只读目录，不触发安装。文档 frontmatter 的单行 `description` 用于
索引，缺省回退到首个标题。skills 不授予网络、写入或发布权限。

## 创建和安装

- `skill_create({ name, description, content? })`：省略正文创建模板；完整正文须有
  匹配名称的 frontmatter。只写用户 home，名称不接受路径或 Windows 保留名。
- `skill_install({ source, name? })`：导入工作区内文件/目录的 `SKILL.md`，或
  HTTPS raw Markdown 链接。可选 `name` 必须与 frontmatter 一致。只复制主文档，
  不复制引用的脚本/资源，不执行下载内容，已有文件不覆盖。
- coding `/skills create <name> <description>`、`/skills install <source> [name]`
  通过 `ToolsService.execute` 执行，列表和候选实时读取目录。Session 写权限仍生效；
  Agent HTTPS 安装调用现有 `http_get`，保留调用身份、取消信号与 PTC 守卫。

内置 `tdd`、`ddd`、`skill-create`、`skill-install` 分别提供测试先行、领域建模、
编写与安装流程。新技能通过源码 loader 与打包后的离线文档共用同一来源。
