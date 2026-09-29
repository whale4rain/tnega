# `apps/web`

Tnega 本地 Web UI（React 19 + Vite + TypeScript）。生产产物由 `pnpm build` 打进 `dist/web`，
由 `tnega web` 托管静态资源与 `/api`。

## 开发

```bash
pnpm tnega web --port 3080          # 后端（API 与 Agent Run）
pnpm --filter @tnega/web dev        # 前端，Vite 把 /api 代理到 127.0.0.1:3080
```

`TNEGA_API=http://host:port` 可改代理目标。

## 功能

- **工作区**：侧栏顶部切换 / 打开 / 移除工作区；浏览按钮优先用桌面端 `tnegaDesktop.pickFolder`，否则调用 `/api/folder-picker`。
- **会话**：按「今天 / 昨天 / 7 天内 / 30 天内 / 更早」分组，可搜索、分支、删除；标题在顶栏点击即可重命名。当前会话写入 URL hash，可直接链接。
- **惰性创建**：「新会话」只是草稿，第一次发送时才 `POST /api/sessions`，并把草稿里的权限、模型、思考强度一并写入，不会留下空会话。
- **Timeline**：两条用户消息之间的全部 Agent 活动折叠为一个回合——Markdown 正文、工具调用、子代理卡片、编辑文件摘要与中断 / 错误提示按发生顺序排列。
  - 连续工具调用合并为「Used N steps」活动组；每一行显示动词 + 目标（`Read src/a.ts`、`Ran pnpm test`），展开看输入与可读化输出（stdout/stderr、文件内容、目录列表）。
  - 子代理卡片汇总状态与最新回信，「Open transcript」在右侧抽屉里用同一个 Timeline 渲染其 Session。
  - 用户消息可复制、编辑重发（`truncate` 后重新运行）、重试；回合可复制或从此处 fork。
- **流式运行**：`POST /runs` 的 SSE 帧按动画帧批量合并进 Timeline；运行结束后重新读取 Session，最终内容以持久化事件为准。别处（另一个标签页、CLI）正在运行的会话会自动轮询刷新。
- **审批**：越权工具调用在输入框上方显示审批卡片（Allow once / Deny）。
- **Plan / Goal**：plan 模式的计划显示为输入框上方的可折叠清单；goal 模式在顶栏显示目标状态与轮次。
- **输入框**：自动增高；`Enter` 发送、`Shift+Enter` 换行、运行中 `Esc` 停止；coding 会话输入 `/` 弹出斜杠命令补全。工具栏芯片切换 Agent 类型、模式、权限、模型与思考强度（运行中锁定）。
- **上下文**：顶栏圆环显示上下文占用，悬浮查看 token、缓存命中率与速度；菜单里可 Compact / Fork / 删除。
- **设置**：弹窗编辑 System Config（协议、模型、Base URL、API Key、思考强度、温度）；API Key 只写不读。
- **主题**：浅色 / 深色 / 跟随系统，首帧前解析，避免闪烁；窄屏下侧栏变为抽屉。

## Project（对齐 Claude Projects）

- 侧栏在 **Sessions / Projects** 间切换；新建项目只需名称，目标可选。路由：`#p/<project>`、`#p/<project>/<thread>`。
- 中间是与协调者的持续对话：协调者派出的 Thread 以卡片嵌在对应位置，实时显示状态与最新回报；协调者的正文流式显示。Thread 工作时也可继续发言。
- 右侧面板：**Overview**（按需要关注 / 工作中 / 已回报 / 已结束分组）、**Memory**（共享记忆：新增、编辑、删除、版本历史）、**Library**（产物与来源）、**Settings**（指令，check-in / 开 Thread / 详略偏好，协调者与 Thread 的模型和思考强度，并行上限，用量，归档与删除）。
- 打开 Thread 后，右侧显示它的目标、Session Timeline 与直接留言框。
- **回复关系**：消息上方的「↩」标签显示它在回应谁（你、协调者或某个 Thread 的回报），点击跳转或打开 Thread；协调者消息与 Thread 卡片可「Reply」，输入框上方显示回复对象，请求携带 `replyTo`。
- **Agent 形象**：简洁可爱的抽象形象——一块软圆的纯色形体（圆、圆角方、倾斜方、软三角、云朵、水滴）加两只白色眼睛（胶囊或圆点），靠眼睛的位置与角度表现性格；无渐变、无高光、无多余细节。`lib/avatar.ts` 按 Agent ID 确定形体、颜色、眼型与视线；协调者为强调色圆形；同一项目内兄弟 Agent 优先使用不同颜色；运行中眨眼、张望、轻微呼吸；点击 Thread 面板或空状态里的形象可重新生成（保存在 `localStorage`）。品牌标志与 favicon 使用同一语言。
- 后端尚未提供的能力（设置、用量、产物内容、添加到 Library、停止）按 [`docs/project/web-contract.md`](../../docs/project/web-contract.md) 的提议接口调用，未实现时降级提示。

## 结构

| 文件 | 角色 |
|---|---|
| `src/lib/types.ts` | 与 `packages/cli/src/server.ts` 的线上契约类型 |
| `src/lib/api.ts` | REST 客户端与 SSE 解析（`streamRun`） |
| `src/lib/timeline.ts` | 纯函数：`fromEvents`（持久事件 → Timeline）与 `applyStream`（Stream Event → Timeline） |
| `src/lib/tools.ts` | 工具调用的动词 / 目标摘要与输出可读化 |
| `src/App.tsx` | 工作区、会话列表、选择、对话框与快捷键 |
| `src/components/Conversation.tsx` | 单个会话：加载、运行、停止、审批、plan、goal、滚动 |
| `src/components/Timeline.tsx` | 回合、工具组、子代理、文件、压缩标记的渲染 |
| `src/components/Composer.tsx` | 输入框、斜杠补全与运行设置芯片 |
| `src/styles/tokens.css` | 设计 token（颜色、圆角、阴影、字体），浅 / 深两套 |
| `src/styles/app.css` | 全部组件样式，只引用 token |
| `src/lib/project-*.ts` | Project 契约类型、API 与 SSE 客户端、纯函数状态归约与投影 |
| `src/components/project/` | Project 视图、Thread 卡片与面板、Overview / Memory / Library / Settings |
| `src/styles/project.css` | Project 界面样式 |

## 约定

- 不引入 UI 组件库；样式只用 `tokens.css` 里的变量，新增颜色先加 token。
- Timeline 的推导逻辑保持为纯函数并在 `timeline.test.ts` 覆盖；组件只负责渲染。
- 服务端事件与字段名沿用 `CONTEXT.md` 术语（Agent Run、Session、Workspace、Stream Event）。
