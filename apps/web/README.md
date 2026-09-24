# `apps/web`

Tnega 本地 Web UI（React + Vite + TypeScript）。生产 dist 打进 npm 包，由
`tnega web` 托管静态资源与 API。

## 功能

- 侧栏同时显示全部已添加工作区，每个工作区独立展开其会话；可按工作区新建、重命名、分支和删除会话，搜索覆盖所有工作区。
- 多轮聊天；工具权限可选只读、工作区可写、Bypass，运行期间不可改，越权请求显示单次审批。
- 会话粒度 mode 切换 `auto / plan / goal`；plan 面板显示 todo 状态，goal 面板显示目标、轮次和暂停／继续操作。
- 对话底部显示活动子代理数量；主对话以任务卡片归并子代理回信，右侧可调整宽度的任务栏使用同一消息渲染器查看子代理 Session。
- 恢复上次会话时先显示可编辑输入框，再加载历史；删除会话使用应用内确认对话框。
- 斜杠命令菜单（coding 会话）；fork；自动标题。
- Coding 工作台：可折叠并记忆状态的侧栏、会话搜索、居中正文和底部输入区。
- 对话使用紧凑的 13px 正文与 1.6 行高；消息和吸附输入区共用全高滚动容器。Plan 显示在输入框上方，可折叠。
- 工具调用默认显示操作、路径／命令预览与执行状态，展开后查看输入输出；多次连续调用折叠成活动组。
- 灰色窗口外壳与圆角深色会话区；用户消息使用右对齐、最多 70% 正文宽度的蓝色气泡，编辑和分支操作位于气泡下方。
- 会话左侧刻度导航支持直接跳转、悬浮内容预览，以及方向键 / Home / End 键导航；侧栏使用紧凑会话行，操作菜单在悬浮或聚焦时显示。
- 右侧 Files / Changes / Terminal 图标可打开占位面板；尚未连接工具，不执行文件或终端操作。
- Radix Themes 提供菜单、对话框、按钮、选择器和提示，Tailwind 提供布局工具类；统一深浅主题、无衬线正文和等宽代码字体。

## 结构

| 文件 | 角色 |
|---|---|
| `App.tsx` | API 状态、会话选择、主题和视图组装 |
| `workbench/WorkbenchShell.tsx` | 窗口布局、折叠侧栏、工具面板插槽 |
| `workbench/WorkspaceSidebar.tsx` | 工作区、会话搜索、操作菜单和对话框 |
| `workbench/WorkspaceTree.tsx` | 按工作区分组的会话树、独立折叠和工作区范围的操作入口 |
| `workbench/ComposerFrame.tsx` | 输入区容器、权限、模型设置入口和模式 |
| `workbench/SettingsView.tsx` | 模型配置表单 |
| `conversation/ChatView.tsx` | 会话运行、流式消费和输入行为 |
| `conversation/SubagentSidebar.tsx` | 子代理任务列表与会话活动侧栏 |
| `conversation/Transcript.tsx` | Markdown 消息、工具组、压缩和命令结果 |
| `conversation/ToolActivity.tsx` / `Disclosure.tsx` | 工具活动摘要与共用可访问折叠组件 |
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
pnpm --filter @tnega/desktop exec electron scripts/verify-workbench.cjs
# 隐藏窗口 + fixture API 验证布局并输出 release/workbench-preview.png，不读取用户数据
```

## 测试

`apps/web/src/*.test.ts`：`projectEvents`（事件→transcript 投影，含 compaction /
中断/重试）与 `planDisplay`。端到端见 `packages/cli/test/web.test.ts`。
