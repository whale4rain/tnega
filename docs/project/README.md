# Project 设计文档

当前设计：[Project v2：Box、Blackboard 与 Project Loop](../superpowers/specs/2026-09-25-project-box-blackboard-design.md)。产品依据见 [新版 Claude Projects 调研](../research/2026-09-25-claude-projects-redesign.md)。

执行计划：[Project v2：Box、Blackboard 与 Project Loop 实施计划](../superpowers/plans/2026-09-25-project-v2-box-blackboard.md)。按插件分模块交付，每个模块一个提交。

选型及旧决策复盘见 [ADR 0008：Project 协作从任务运行时转向 Box、Blackboard 与 Project Loop](../adr/0008-project-box-blackboard.md)。

历史材料保留原文：[2026-09-24 运行时设计](../superpowers/specs/2026-09-24-project-collaboration-design.md)、[2026-09-25 实施计划](../superpowers/plans/2026-09-25-project-collaboration-implementation.md)和[产品形式过渡对齐稿](../superpowers/specs/2026-09-25-project-product-realignment.md)。这些文件描述旧决策及其执行路径，不是当前实施依据。

## 已实现的包

| 包 | 角色 |
| --- | --- |
| `@tnega/blackboard` / `blackboard-local` | 共享事实：有类型的版本记录与条件提交 |
| `@tnega/artifact-store` / `artifact-local` | 产物内容：按哈希寻址 |
| `@tnega/project` / `project-local` | Project 身份与目录 |
| `@tnega/box` / `box-blackboard` | 消息通道：信封与至少一次投递 |
| `@tnega/thread` / `thread-local` | Thread 身份、Agent 文件夹与父子关系 |
| `@tnega/project-loop` | 投递、唤醒、发布回复、父子回报、崩溃恢复 |
| `@tnega/tool-blackboard` / `tool-thread` / `tool-box` | 模型可见的项目记忆、委派与发言工具 |
| `@tnega/cli` 的 Project Host | 装配 Project 作用域，并把它投影成 HTTP 与 SSE |

## Project HTTP 面

所有路由都在 `/api/` 下，需要 `x-tnega-client: 1`，并带 `?workspace=<绝对路径>`。

| 方法与路径 | 语义 |
| --- | --- |
| `GET /api/projects` | 列出该 workspace 的 Project |
| `POST /api/projects` | 建 Project：`{ name, goal? }`；`?workspace=<文件夹>` 就是它的工作位置，不存在时创建 |
| `GET /api/projects/:id` | 快照：Project、协调者 ID、游标、Thread、主对话、记忆、Library |
| `POST /api/projects/:id/messages` | 主对话发言：`{ text }`；回执表示信封落盘，不是模型回复 |
| `POST /api/projects/:id/threads/:tid/messages` | 直接给某个 Thread 留言 |
| `GET /api/projects/:id/threads/:tid` | 该 Thread 的记录与它的 Session 事件 |
| `POST /api/projects/:id/memory` | 新增一条项目记忆 |
| `GET /api/projects/:id/memory/:mid` | 该记忆的全部版本与来源 |
| `PATCH /api/projects/:id/memory/:mid` | 改或删：`{ text, expected_version, deleted? }`；版本不符返回 409 与当前内容 |
| `POST /api/projects/:id/approvals/:aid` | 越权调用的授权决定：`{ allow }` |
| `GET /api/projects/:id/stream` | SSE：`after` 之后的消息 + 事实提交 + 授权请求 + 心跳 |

UI 的投影规则：主对话读 `placement.kind === 'main'` 的信封（`dispatch` 渲染成 Thread 卡片，
`threadId` 指向它代表的 Thread）；Thread 面板读该 Agent 的 Session 事件；卡片状态读
Thread 记录；Library 与 Memory 读 Blackboard。不从模型文本里猜任何一件事。

## Web 屏

Project 屏与会话屏共用同一套骨架：`WorkbenchShell` 里一块主内容加一个可选侧栏，左栏还是
`WorkspaceSidebar`（Projects 一节在 Workspaces 之上）。切到 Project 只是换主内容，不是换界面。

| 位置 | 内容 |
| --- | --- |
| 左栏 Projects | 最近打开的 Project（名称 + 它所在的文件夹）；`+` 新建。点一行就进 Project 屏，点会话就回会话屏 |
| 顶部 | Project 名称、文件夹、目标，以及 Overview / Library / Memory 三个面板入口 |
| 主对话 | 用户发言与协调者回复用会话屏的消息渲染；派工是一条线程卡片，直接显示该 Thread 的状态、步骤进度与回复数 |
| 右下角 | `N active tasks · M total` 开关，打开右侧 Thread 栏 |
| Thread 栏 | `Threads > 线程名` 面包屑、线程上下文、结构化执行计划（✓ / ● / ○）、该 Agent 的回复与工具行，底部是它自己的输入区 |

信息按 Application → Project/Agent → Conversation → Thread → Task Execution 组织：

- **Project 是长期工作空间**。一个 Project 就是一个文件夹：创建时选（或新建）目录，它的
  记忆、Thread 与产物都在那个目录下，Agent 也在那里运行。
- **Thread 是一等公民**。派工卡片上的步骤与回复数直接读 Thread 的记录与它的 Session；
  点开右侧栏看完整执行记录，并在那里直接留言。
- **Task / Plan / Tool 是结构化对象**。步骤从 Session 的 `plan` 事件投影成 ✓ / ● / ○，
  工具调用是独立的行（可展开看输出），产物进 Library —— 都不从回复正文里猜。
- **输入区**。主对话与 Thread 各有一份，沿用会话屏的 `.composer-*` 度量；模型与思考强度
  写的是这台机器的默认配置（和设置里是同一份），上下文一栏显示这轮会看到的文件夹与权限。

创建只要名称与文件夹；目标可以后补，创建时不拉起任何 Agent。发完就显示（判据是信封落盘，
不是模型回复；本地先画出来，流里那条按 `messageId` 去重）。断线按游标补齐：连接从快照的
游标开始，重连时服务端先补 `after` 之后的消息，再持续推送事实提交与授权请求。记忆可编辑、
可追溯：编辑带上读到的版本号，版本不符时界面拿到 409 与当前内容，重新读取后再提交。
