# Project Web 契约（前端 ↔ 后端）

日期：2026-09-28。前端实现见 `apps/web/src/components/project/` 与 `apps/web/src/lib/project-*.ts`。

新版 Web 的 Project 体验对齐 [Claude Projects 2026-09-17 重设计](https://claude.com/blog/projects-redesigned)：
一个 Project 是一段持续的**协调者对话**，协调者把工作拆给**并行的 Thread**，Thread 共享**记忆**与
**Library**，用户可随时打开任意 Thread 查看、直接留言纠偏。本文列出前端已经依赖的接口，以及为了补齐
Claude Projects 的能力而**提议**的接口。提议接口尚未实现时，前端会降级并提示，不会报错崩溃。

## 概念映射

| Claude Projects | Tnega 对象 | 前端位置 |
| --- | --- | --- |
| Project（主对话 / chief of staff） | `ProjectRecord` + 根 Thread（`coordinatorId`） | 中间的主对话 |
| Thread（并行的工作会话） | 子 `ThreadRecord`，各自一个 Session | 主对话里的 Thread 卡片；右侧 Thread 面板 |
| 在主对话里看进度 / 进入 Thread 细调 | Box 信封（`dispatch` 卡片）/ Thread 记录（状态、实时清单）/ Thread Session | 卡片只有标题与状态；Thread 面板先给清单、产物与回答，步骤折叠 |
| Shared memory | Blackboard `memory` 事实（有版本） | 右侧 Memory：新增、编辑、删除、版本历史 |
| Library（你加的文件 + Claude 的产物） | Blackboard `artifact` / `resource` + Artifact Store | 右侧 Library：列表、查看、添加 |
| 偏好：check-in 频率、开 Thread 的积极度、更新详略 | **提议** `settings.preferences` | 右侧 Settings |
| 协调者与 Thread 分别选模型和思考强度 | **提议** `settings.coordinator` / `settings.threads` | 右侧 Settings |
| 按 Project 查看用量 | `GET …/usage?since=` | Board 卡片与「今天」；Settings → Usage |
| Routines | Blackboard `routine` 事实；`POST …/routines`、`PATCH …/routines/:id`、`POST …/routines/:id/run` | 工作台 Routines 标签 |
| 收下结果（Resolved） | `PATCH …/threads/:id` `{ resolved }` | Board 卡片与 Thread 标签的 Resolve / Reopen |
| （Tnega 补充）暂停全部 / 停止单个 Thread | `POST …/stop`、`POST …/threads/:id/stop` | 顶栏菜单；Thread 面板 Stop |

Claude 的云端运行、按分支隔离与团队共享不在本期范围；Tnega 仍是本地产品。

## 已实现、前端已使用的接口

所有请求带 `x-tnega-client: 1` 与 `?workspace=<abs path>`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/projects` | 侧栏项目列表（含 `archived`） |
| POST | `/api/projects` `{ name, goal? }` | 新建项目，只需名称 |
| GET | `/api/projects/:id` | 快照：`project`、`coordinatorId`、`cursor`、`threads`、`messages`（主对话）、`inboxMessages`（子→协调者回报）、`memory`、`library` |
| PATCH | `/api/projects/:id` `{ archived }` | 归档 / 恢复 |
| DELETE | `/api/projects/:id` | 删除 |
| POST | `/api/projects/:id/messages` `{ text }` | 主对话发言；回执即成功，协调者运行时也可发送 |
| GET | `/api/projects/:id/threads/:threadId` | Thread 记录 + Session 事件（面板复用会话 Timeline 渲染） |
| POST | `/api/projects/:id/threads/:threadId/messages` `{ text }` | 直接给 Thread 留言；协调者只收到一条不唤醒它的通知，主对话里不出现 |
| POST | `/api/projects/:id/threads/:threadId/stop` | 取消该 Thread 当前的 Agent Run 并清空它已收下的待处理输入；Box 里尚未投递的信封保留。返回 `{ stopped: boolean }` |
| POST | `/api/projects/:id/stop` | 对所有正在跑的 Agent 做同样操作，返回 `{ stopped: number }` |
| GET | `/api/projects/:id/artifacts/:hash` | 已登记在 Library 里的产物内容。一律按 `text/plain` 返回（`nosniff`、CSP `sandbox`），真实类型在 `x-artifact-media-type` 头里；前端把 HTML 放进 `sandbox="allow-scripts"` 的 iframe，Markdown 渲染，其余按代码块显示 |
| POST | `/api/projects/:id/approvals/:approvalId` `{ allow }` | 越权工具审批 |
| POST | `/api/projects/:id/memory` `{ text, tags? }` | 新增记忆（正文中的 `#tag` 会被提取为 tags） |
| PATCH | `/api/projects/:id/memory/:memoryId` `{ text, expected_version, tags? }` / `{ deleted: true, expected_version }` | 编辑 / 删除；前端写之前先读历史取当前版本，409 时保留草稿并提示 |
| GET | `/api/projects/:id/memory/:memoryId` | 版本历史 |
| GET | `/api/projects/:id/stream?after=<cursor>` | SSE 变化流，断线后按游标重连 |
| GET | `/api/projects/:id/usage?since=<ms>` | 每个 Thread 的 token、回复数、工作时长（turn 开始到结束）与最近活动；`since` 另给这之后的汇总（Board 的「今天」） |
| PATCH | `/api/projects/:id/threads/:threadId` `{ resolved }` | 收下 / 重新打开 Thread；正在跑时收下会先停下它 |
| POST / PATCH | `/api/projects/:id/routines`、`/routines/:id` | 建、改、暂停（`enabled`）、删除（`deleted`）Routine；日程不合法返回 400 |
| POST | `/api/projects/:id/routines/:id/run` | 立即运行一次 Routine |

流帧：`message`（信封，含 `seq`）、`commit`（`agent` / `memory` / `artifact` / `resource` / `project`，带 `author`、`version`、`updatedAt`、`source`）、
`chunk`（`agentId` 的实时正文增量）、`agent-status`（`running` / `idle`）、`approval/request`、`heartbeat`。

前端的推导规则（见 `project-model.ts`）：主对话只读 `placement.kind === 'main'` 的用户发言、协调者回复与
`dispatch`（`notice` 不显示）；连续的 `dispatch` 合成一组卡片；卡片状态读 Thread 记录，并以 `agent-status`
覆盖，工作中显示清单里 `active` 的那一步；回复的 `refs` 按哈希对到 Library 的产物，渲染成卡片；Thread
面板的产物按 `author` 归属；协调者的 `chunk` 作为流式草稿显示，收到它的 `agent-reply` 后替换。

## 提议的后端改动

按优先级排列。每项都给出前端当前的降级行为。

### P0-0 按消息回复（reply-to）

**现状。** 协调者的 `agent-reply` 已带 `causationId`（取自 `lastInboundMessageId`），前端据此在消息上方显示
「↩ 回复 用户 / 某个 Thread 的回报 / 你给 Thread 的留言」。但这是隐式的：一轮里同时收到多封消息
（例如两个 Thread 先后回报）时，协调者只产出一条合并简报，`causationId` 只指向最后一封，其余消息
没有任何回应的链接；用户和 Agent 也都无法**指定**回复哪一条消息。

**需要的能力：**

1. **用户指定回复对象。** `POST /api/projects/:id/messages` 接受 `{ text, replyTo?: messageId }`，写入信封的
   `causationId`。协调者收件时，模型可见文本带上被回复消息的引用，例如：
   `[Replying to <Thread 标签 | Coordinator>: "<摘录>"]`。前端已经发送 `replyTo`；服务端落盘前，前端把
   关联暂存在 `localStorage`（`tnega.replies.<projectId>`），只影响显示。
2. **Agent 指定回复对象。** `send_project_message` 与 `send_thread_message` 增加可选参数
   `reply_to: string | string[]`（消息 ID），并在模型可见的 inbox 文本中暴露每封消息的 ID（如
   `<message id="…" from="…">`），让模型能引用。自动发布的 `agent-reply` 同样应能表达多个来源。
3. **信封字段。** `BoxEnvelope` 增加可选 `replyTo?: string[]`，表示这条消息回应的全部消息；`causationId`
   保持为因果链的主来源。前端同时读取两者（`repliesOf()`），并按「谁发的」显示：你 / 协调者 / Thread。
4. **逐条回应策略（Project Loop）。** 一轮消费多封入站消息时，协调者要么对每封分别回复（每条
   `agent-reply` 的 `causationId` 指向对应消息），要么发一条合并回复并在 `replyTo` 列出全部来源。
   这可以放在协调者系统提示中约定，也可以由 Project Loop 在唤醒时逐封投递。与 `preferences.checkIns`
   配合：`often` 倾向逐条回复，`milestones` / `end` 允许合并但必须列全来源。
5. **派工也带因果。** `spawn_thread` 生成的 `dispatch` 信封应带 `causationId`（触发它的用户消息），
   前端就能在卡片上显示「为回应哪条请求而开」。

前端现状：消息上方的回复标签（点击跳到原消息并高亮；若原消息在 Thread 内则打开该 Thread）、协调者消息和
Thread 卡片上的「Reply」按钮、输入框上方的「Replying to …」提示条都已实现；紧挨着回复的上一条消息不重复显示标签。

### P0-2 项目设置：`PATCH /api/projects/:id` 接受 `name`、`goal`、`settings`

```ts
interface ProjectSettings {
  instructions?: string                       // 协调者与所有 Thread 的项目级指令
  coordinator?: { model?: string; reasoningEffort?: 'low' | 'medium' | 'high' }
  threads?: { model?: string; reasoningEffort?: 'low' | 'medium' | 'high' }
  preferences?: {
    checkIns?: 'often' | 'milestones' | 'end'          // 协调者多久主动简报
    threadSpawning?: 'ask-first' | 'balanced' | 'proactive' // 开新 Thread 的积极度
    updateDetail?: 'brief' | 'standard' | 'detailed'   // 简报详略
  }
  permission?: 'read-only' | 'workspace-write' | 'bypass' // 所有 Thread 的上限
  maxParallelThreads?: number                  // 同时 working 的 Thread 上限
}
```

- 持久化在 `project` 事实里，快照的 `project.settings` 返回当前值；修改走 `commit` 帧（`kind: 'project'`）。
- `instructions` 与 `preferences` 在组装协调者 / Thread 的系统提示时注入；修改在下一个安全边界生效。
- `coordinator` / `threads` 的模型从 System Config 的模型路由中选择；`projectHostFor` 目前整个 Project
  只用一个 adapter，需要按角色创建 adapter（`thread-local` 的 `llm` 改为按角色取）。
- `maxParallelThreads` 对应 `thread-local` 的并发上限；`threadSpawning: 'ask-first'` 时协调者先在主对话提议，
  得到用户同意再 `spawn_thread`。
- 降级：前端在 PATCH 返回 400（`archived must be a boolean`）/404/405 时提示「服务端尚不支持」。

### P1-3 添加到 Library：`POST /api/projects/:id/library`

- 文本 / 文件：`{ title, content, mediaType? }` → `artifacts.put` 后提交 `artifact` 事实，`author: 'user'`。
- 链接：`{ title, uri, note? }` → 提交 `resource` 事实。
- 返回 `{ record }`。前端在浏览器里读取 ≤ 2 MB 的文本文件后以 `content` 上传。

### P2 体验改进（可选）

- 协调者在调用 `spawn_thread` 前说的话（例如「我会拆成两个 Thread」）目前不发布到 Box，主对话只看到卡片。
  可考虑把带工具调用的 assistant 消息正文也作为 `agent-reply` 发布。
- Thread Session 里来自协调者的 `user/message` 没有带发送者；若在 `name` 中写入 `agent:<coordinatorId>`，
  前端可以把它标成「来自协调者」而不是用户气泡。
- 快照可附带每个 Thread 最近一次 `request` 的内容，便于在 Overview 的 Needs attention 中直接回答。

## 前端降级约定

`isUnsupported(error)` 把 404、405、501 以及旧版 PATCH 的 400 视为「尚未实现」。所有提议接口的调用点
都显示说明性提示，不影响其余功能。后端实现某项后，前端无需修改即可生效。
