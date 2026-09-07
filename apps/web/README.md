# `apps/web`

Tnega 本地 Web UI（React + Vite + TypeScript）。生产 dist 打进 npm 包，由
`tnega web` 托管静态资源与 API。

## 功能

- 侧栏最近工作区 + 添加路径；会话列表（general / coding 徽标）。
- 多轮聊天；工具权限开关（network / shell，运行时选择一次，run 期间不可改）。
- 会话粒度 mode 切换 `auto / plan / execute`；plan 面板实时显示 todo 状态。
- 斜杠命令菜单（coding 会话）；fork；自动标题。
- 主题切换；浅色 manpage 视觉风格。

## 结构

| 文件 | 角色 |
|---|---|
| `App.tsx` | 主布局与路由（大型组件已拆） |
| `ConversationNav.tsx` / `sessionSelection.ts` | 会话列表与选择 |
| `PlanPanel.tsx` / `planDisplay.ts` | plan 面板与 slash 消息显示 |
| `projectEvents.ts` | 把 session 事件流投影成 transcript（人类视图；system 提示与 compaction 进程不污染） |
| `toolGroups.ts` | 工具权限分组 |
| `api.ts` | 后端调用 |
| `types.ts` | 与后端对齐的 session 事件类型 |

## 数据流

- 会话事件经 SSE 流式到达，UI 按 `session/event` 增量更新；最终状态以刷新后
  `GET /api/sessions/:id` 的 events/surface 为准。
- transcript 与模型上下文不同源：`projectEvents.ts` 从事件投影人类可读视图，
  system prompt、`request/*`、turn/step 等不显示为气泡。

## 开发

```bash
pnpm --filter @tnega/web dev      # Vite dev server
pnpm build                        # 构建生产 dist
```

## 测试

`apps/web/src/*.test.ts`：`projectEvents`（事件→transcript 投影，含 compaction /
中断/重试）与 `planDisplay`。端到端见 `packages/cli/test/web.test.ts`。
