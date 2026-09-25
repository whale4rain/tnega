# `apps/web`

Tnega 本地 Web UI（React + Vite + TypeScript）。生产 dist 打进 npm 包，由
`tnega web` 托管静态资源与 API。

## 功能

- 侧栏同时显示全部已添加工作区，每个工作区独立展开其会话；可按工作区新建、重命名、分支和删除会话，搜索覆盖所有工作区。
- 多轮聊天；工具权限可选只读、工作区可写、Bypass，运行期间不可改，越权请求显示单次审批。
- 输入框下方的模型与思考强度滑块读取 System Config 的模型列表；Settings 在当前界面的弹窗中打开。
- 会话粒度 mode 切换 `auto / plan / goal`；plan 面板显示 todo 状态，goal 面板显示目标、轮次和暂停／继续操作。
- 对话底部显示活动子代理数量；主对话以任务卡片归并子代理回信，右侧可调整宽度的任务栏使用同一消息渲染器查看子代理 Session。
- 恢复上次会话时先显示可编辑输入框，再加载历史；删除会话使用应用内确认对话框。
- 斜杠命令菜单（coding 会话）；fork；自动标题。
- Coding 工作台：可折叠并记忆状态的侧栏、会话搜索、居中正文和底部输入区。
- 对话使用紧凑的 13px 正文与 1.6 行高；消息和吸附输入区共用全高滚动容器。Plan 显示在输入框上方，可折叠。
- 工具调用默认显示操作、路径／命令预览与执行状态，展开后查看输入输出；多次连续调用折叠成活动组。
- 每次 Agent Run 结束后显示“已编辑 X 个文件”卡片与行数变化，默认列出 3 个文件，可展开剩余路径；Git 工作区比较运行前后状态，非 Git 工作区的 `write_file` 使用写入前快照，摘要保存在 Session 中。
- 灰色窗口外壳与圆角深色会话区；用户消息使用右对齐、最多 70% 正文宽度的蓝色气泡，编辑和分支操作位于气泡下方。
- 会话左侧刻度导航支持直接跳转、悬浮内容预览，以及方向键 / Home / End 键导航；侧栏使用紧凑会话行，操作菜单在悬浮或聚焦时显示。
- 右侧 Files / Changes / Terminal 图标可打开占位面板；尚未连接工具，不执行文件或终端操作。
- Astryx（`@astryxdesign/core` + `@astryxdesign/theme-neutral`）提供外壳、导航、表单、对话框、聊天和折叠等全部界面组件；Tailwind 只提供布局工具类。

## Astryx

- 组件从 `@astryxdesign/core/<Component>` 逐组件引入，样式由 StyleX 在构建期生成。
- `main.tsx` 只加载 `styles.css`；`styles.css` 以显式 cascade layer 顺序（`reset, theme, base, components, legacy, astryx-base, utilities`）引入 Astryx reset 与主题，再引入 Tailwind 的 theme/utilities 层。
- `App.tsx` 用 `@astryxdesign/core/theme` 的 `Theme` 包住整棵树，深浅模式跟随本机偏好并在 `localStorage` 中记忆。
- 需要查组件 API 时用仓库内的 CLI，而不是猜：
  ```bash
  pnpm --filter @tnega/web astryx component ChatComposer
  pnpm --filter @tnega/web astryx search "popover"
  ```
- 少数界面刻意保留 Tnega 自己的实现（斜杠命令菜单、子代理卡片、会话刻度导航、项目行）；理由记在 `docs/superpowers/plans/2026-09-26-frontend-astryx-rebuild.md` 的 “Recorded exceptions”。

## 结构

| 文件 | 角色 |
|---|---|
| `App.tsx` | API 状态、会话选择、主题和视图组装 |
| `workbench/WorkbenchShell.tsx` | 窗口布局、折叠侧栏、工具面板插槽 |
| `workbench/WorkspaceSidebar.tsx` | 工作区、会话搜索、操作菜单和对话框 |
| `workbench/WorkspaceTree.tsx` | 按工作区分组的会话树、独立折叠和工作区范围的操作入口 |
| `workbench/ComposerFrame.tsx` | 输入区容器、权限、模型设置入口和模式；输入与发送由 `ChatComposer` 提供 |
| `workbench/SettingsView.tsx` | 模型配置表单 |
| `conversation/ChatView.tsx` | 会话运行、流式消费和输入行为 |
| `conversation/SubagentSidebar.tsx` | 子代理任务列表与会话活动侧栏 |
| `conversation/Transcript.tsx` | Markdown 消息、工具组、压缩和命令结果 |
| `conversation/ToolActivity.tsx` | 工具调用交给 `ChatToolCalls` 呈现，输出截断与 spill 提示留在本地 |
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

`apps/desktop/scripts/verify-workbench.cjs`（隐藏窗口 + fixture API，输出
`release/workbench-preview.png`）目前跑不通：它断言的 `.session-link` /
`.window-bar` / `.workbench-body` / `.rt-*` 和 `.composer` 都是迁移前的标记，
Astryx 重建后已不存在。重建它还意味着重新确定它顺带断言的那些视觉契约
（气泡宽度比例、圆角、配色），那是设计决定而不是机械替换，所以留待单独处理。

## 测试

`apps/web/src/**/*.test.ts`（jsdom）覆盖事件投影（`projectEvents` / `planDisplay`）、
工具分组与输出截断（`toolGroups` / `toolOutput`）、会话选择与项目状态
（`projectSelection` / `projectExperience`）、输入区行为（`composer`）、侧栏与外壳
（`App` / `workbench`）以及桌面桥。`vitest.setup.ts` 给 jsdom 补上 Astryx 需要的
`matchMedia`。端到端见 `packages/cli/test/web.test.ts`。
