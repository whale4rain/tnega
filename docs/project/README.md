# Project 设计文档

Projects 产品设计（最新）：[Projects: a room where people and agents work together](projects-design.md)。

运行时设计：[Project v2：Box、Blackboard 与 Project Loop](../superpowers/specs/2026-09-25-project-box-blackboard-design.md)。产品依据见 [新版 Claude Projects 调研](../research/2026-09-25-claude-projects-redesign.md)。

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
| `GET /api/projects` | 列出该 workspace 的 Project；每项带 `threads: { waiting, failed, working }` 摘要（等你或阻塞、失败、工作中的 Thread 数，不含协调者），侧栏据此亮状态灯。未挂载的 Project 只读其 Blackboard 上的 Thread 记录，不会因此启动 Agent |
| `POST /api/projects` | 建 Project：`{ name, goal? }`；`?workspace=<文件夹>` 就是它的工作位置，不存在时创建 |
| `GET /api/projects/:id` | 快照：Project、协调者 ID、游标、Thread、主对话、记忆、Library |
| `POST /api/projects/:id/messages` | 主对话发言：`{ text, replyTo? }`；`replyTo` 存为信封的 `causationId`；回执表示信封落盘，不是模型回复 |
| `POST /api/projects/:id/threads/:tid/messages` | 直接给某个 Thread 留言；协调者只收一条不唤醒它的通知 |
| `POST /api/projects/:id/threads/:tid/stop` | 停下该 Thread 正在跑的工作 |
| `POST /api/projects/:id/stop` | 停下所有正在跑的 Agent |
| `GET /api/projects/:id/artifacts/:hash` | Library 里登记过的产物内容：文本按纯文本、其余按字节流返回，由前端在沙箱里渲染 |
| `PATCH /api/projects/:id/threads/:tid` | `{ resolved }`：人收下（或重新打开）一个 Thread |
| `GET /api/projects/:id/usage?since=` | 每个 Thread 与整个 Project 的 token 与工作时长；`since` 另算这之后的部分 |
| `POST /api/projects/:id/routines` | 建 Routine：`{ title, prompt, schedule }` |
| `PATCH /api/projects/:id/routines/:rid` | 改、暂停、恢复或删除 Routine |
| `POST /api/projects/:id/routines/:rid/run` | 立即运行一次 |
| `GET /api/projects/:id/threads/:tid` | 该 Thread 的记录与它的 Session 事件 |
| `POST /api/projects/:id/memory` | 新增一条项目记忆 |
| `GET /api/projects/:id/memory/:mid` | 该记忆的全部版本与来源 |
| `PATCH /api/projects/:id/memory/:mid` | 改或删：`{ text, expected_version, deleted? }`；版本不符返回 409 与当前内容 |
| `POST /api/projects/:id/approvals/:aid` | 越权调用的授权决定：`{ allow }` |
| `GET /api/projects/:id/stream` | SSE：`after` 之后的消息 + 事实提交 + 授权请求 + 心跳 |

UI 的投影规则：主对话读 `placement.kind === 'main'` 的用户发言、协调者回复与 `dispatch`
（渲染成 Thread 卡片，`threadId` 指向它代表的 Thread）；Thread 面板读该 Agent 的 Session 事件；
卡片状态与实时清单读 Thread 记录；回复下的产物卡片读信封的 `refs`；Library 与 Memory 读
Blackboard。不从模型文本里猜任何一件事。

## 设计原则

Project 是一个「群聊」：主对话短、好扫读，每件专注的工作有自己的 Thread。平静来自决定**不**显示什么。

- **协调者加 Thread**。协调者看着主对话，开 Thread，把用户的话转给负责的 Thread。每个 Thread 是一个
  长期存在的 Agent，有自己的 Session，多个 Thread 并行工作。
- **结果留在做事的地方**。Thread 在自己的时间线里回报，用户收到通知（卡片上的未读点、桌面端提醒）；
  回报只作为上下文进入协调者（`inject`，不起新一轮），协调者不在主对话里复述。只有
  `request` / `blocked` / `failed` 会唤醒协调者：它能决定就直接回 Thread，需要用户决定才在主对话里问。
- **渐进披露**。先给结果；推理与内部步骤折叠，用户要看才展开。
- **状态可见**。工作中的 Thread 用 `update_checklist` 维护一份实时清单，写在 Thread 记录上；卡片显示
  当前那一步，Thread 面板显示整份清单。
- **产物是卡片**。`publish_artifact` 的产物挂在产生它的那条回复下（信封 `refs`），同时收进 Library；
  HTML 产物是可交互的网页，在沙箱 iframe 里打开。不把内容贴进对话。
- **克制**。一个声音（协调者）、很少的颜色（只有需要用户的状态和失败有颜色）、没有日志。
- **长期连续**。上下文满了自动压缩，共享记忆保存长期事实，Thread 把各自话题的上下文分开。

## Web 屏

Project 屏与会话屏共用同一套骨架：左栏、主内容、右侧**工作台**。Project 的面板就是会话的工作台
（同样的位置、宽度、拖拽与 Ctrl+J），只是它的标签栏以 Board · Library · Routines 开头，打开的
Thread 与 Project 设置是可关闭的标签，后面仍是 Files · Changes · Terminal · Browser。设计依据见
[projects-design.md](projects-design.md)。

| 位置 | 内容 |
| --- | --- |
| 左栏 Projects | 最近打开的 Project（名称 + 它所在的文件夹）；`+` 新建 |
| 顶部 | Project 名称；有 Thread 在跑时一行「N threads working」，断线时「Reconnecting…」 |
| 主对话 | 任务驱动：你的消息是靠右的气泡；协调者的回复是没有头像和气泡的正文，按天分隔，协调者工作时显示「Coordinating…」。交出去的工作是一张 Thread 链接卡：**状态灯 · 标题 · 状态**（工作中显示清单的当前一步），每个 Thread 只出现一次，点开打开 Thread；协调者正文里用 `[标题](#thread:<id>)` 链接 Thread。悬停卡片可「回复」，消息直接发给那个 Thread。回复带产物时下面是产物卡片 |
| Board | 顶部是项目天气与「今天」：开了几个 Thread、完成几个、产出几份、用了多少 token；下面是 Needs you · Working · Ready · Idle 四条泳道（宽面板并排成看板，窄面板纵向堆叠），Resolved 折叠。卡片有状态灯、当前步骤 / 等待的问题 / 回报首行、清单进度条、产物类型、最近活动、工作时长与 token；悬停可 Resolve / Reopen / Stop |
| Library | 人加的与 Thread 产出的，按类型（Pages · Docs · Slides · Sheets · Data…）筛选；就地预览，Word / PowerPoint / Excel / PDF 用工作区文件的同一套预览器 |
| Routines | 定时工作：日程、下次运行、上次运行与错误；可新建、暂停、恢复、立即运行、删除。每次运行进入它自己的 Thread |
| Thread 标签 | 标题与状态、Stop / Resolve / Reopen；然后依次是实时清单、产物卡片、折叠的 Brief、每轮的回答（步骤折叠成「Show N steps」），底部是直接给它留言的输入框 |
| Project 设置 | Brief（目标、指令）、**Memory**、协作偏好、模型、用量、归档与删除 |

- **Project 是长期工作空间**。一个 Project 就是一个文件夹：创建时选（或新建）目录，它的
  记忆、Thread 与产物都在那个目录下，Agent 也在那里运行。
- **输入区**。主对话与 Thread 用同一个一行高的输入框（`PromptBox` 的 `inline`），随输入增高；
  Project 这一层改不了工具权限、也没有 plan/goal 模式，所以不渲染这两个控件。
- **流的状态可见**。断线后客户端按游标自己接回来，不靠刷新。

创建只要名称与文件夹；目标可以后补，创建时不拉起任何 Agent。发完就显示（判据是信封落盘，
不是模型回复；本地先画出来，流里那条按 `messageId` 去重）。断线按游标补齐：连接从快照的
游标开始，重连时服务端先补 `after` 之后的消息，再持续推送事实提交与授权请求。记忆可编辑、
可追溯：编辑带上读到的版本号，版本不符时界面拿到 409 与当前内容，重新读取后再提交。
