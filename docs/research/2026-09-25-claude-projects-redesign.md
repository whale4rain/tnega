# Claude Projects 新版产品形态核对

调研日期：2026-09-25。这里将“晚于 9 月”按“2026 年 9 月新版发布后”理解；当前仍在 9 月，无法找到 2026 年 10 月及之后的公开材料。只采用 Anthropic/Claude 自有的公告、帮助中心和产品文档。用户提供的截图是界面观察，不将其画面中的话或视频字幕当成 Anthropic 产品承诺。

## 结论

2026-09-17 的[官方公告](https://claude.com/blog/projects-redesigned)宣布新版 Projects beta。其中心结构是**一个持续的项目对话加多个执行线程**：用户在项目对话中持续交代工作，协调者把工作分派到新线程或已有线程，汇总结果；用户也能打开单个线程查看和干预。项目具备共享的仓库/文件、指令和记忆，Overview 汇总各线程状态。旧版“知识库 + 多个独立聊天”的 Projects 同时继续存在，不能把旧版说明或现有项目的行为当成新版设计。[官方帮助页](https://support.claude.com/en/articles/9517075-what-are-projects)、[Claude Code Projects 文档](https://code.claude.com/docs/en/claude-projects)。

## 一手证据与时间

| 来源 | 日期 | 已明确写出的事实 |
| --- | --- | --- |
| [Projects redesigned: from folder to conversation](https://claude.com/blog/projects-redesigned) | 2026-09-17 | 项目有协调者与执行线程。项目创建时可设目标及仓库或背景；项目可配置云环境、连接器、插件、指令和模型。主项目聊天可监控与指导进度，也能进入单线程；协调者把新工作路由给新线程或已有线程。每个云线程有独立分支和仓库副本，线程可进一步使用 subagent、loop、workflow。共享记忆与 Library 积累项目资料和产物。|
| [What are projects?](https://support.claude.com/en/articles/9517075-what-are-projects) | 页面标示“Updated this week”，未给精确日期；2026-09-25 核对 | 新版 beta 中一个项目是一段对话，Claude 拆为并行云线程；它告知已完成和等待用户处理的事项。每个线程从项目文件、仓库、指令和记忆开始。该页明确说后续章节仍介绍旧版。|
| [Let Claude coordinate ongoing work with Projects](https://code.claude.com/docs/en/claude-projects) | 页面未标发布日期；2026-09-25 核对 | 详述项目对话、独立线程、Overview 与 Library 的关系及工作流。主对话接收线程报告，但不读取每个执行步骤。线程卡片出现在触发它的主对话消息下，并显示标题及状态。|

### 产品结构

- **主项目对话**：协调者接收不断追加的任务、更新和问题。快速问题可在原处回答；新工作可开新线程，或交给已在相应领域工作的线程；同一条消息中的互不相关任务可拆成多个线程。[官方文档：Send work and read results](https://code.claude.com/docs/en/claude-projects#send-work-and-read-results)。
- **执行线程**：每个线程是独立 Session、独立上下文，云端代码线程在自己的分支工作，需要时开 PR，并向主对话回报。主对话只看线程回报；用户打开线程后才能逐步查看过程、直接留言、回答权限请求或中止。[官方文档：How a project is organized](https://code.claude.com/docs/en/claude-projects#how-a-project-is-organized)、[Open a thread when you need control](https://code.claude.com/docs/en/claude-projects#open-a-thread-when-you-need-control)。
- **Overview**：主对话旁的面板可关闭/重开；Threads 页按 Ready for review、Waiting on you、Working、Landing、Idle、Resolved 分类。单线程可从主对话卡片或 Overview 行打开，内容显示在 Overview 面板中。面板还含 Library、Pull requests、Routines 页。[官方文档：See what needs you in Overview](https://code.claude.com/docs/en/claude-projects#see-what-needs-you-in-overview)。
- **共享上下文**：项目指令会提供给主对话和新线程；项目记忆是跨线程共享的文件；仓库、文件和云环境是项目级配置。Library 收集用户上传文件和线程产物。[官方文档：Give a project standing context](https://code.claude.com/docs/en/claude-projects#give-a-project-standing-context)。
- **持续运行与限制**：云线程在关闭电脑后继续。官方公告说新版当时先向符合条件的 Pro/Max Claude Code 云会话用户逐步开放，聊天、Cowork、Team、Enterprise 后续推出；既有项目暂按旧方式运行。公告当时称本机线程“即将推出”；目前产品文档已描述可通过 Remote Control 请求本机执行，显示两份资料时间不同，不宜把 9 月 17 日的限制视为永久事实。[公告](https://claude.com/blog/projects-redesigned)、[帮助页](https://support.claude.com/en/articles/9517075-what-are-projects)、[产品文档](https://code.claude.com/docs/en/claude-projects)。

### 用户截图能支持什么

截图中左侧显示 Projects 入口及置顶项目，中间是项目对话，右侧有 `Threads > Composio skills article` 的线程详情，项目标题旁有 `Overview`。主对话中的线程卡片及“Already in its own new thread”与官方文档“消息下方出现线程卡片、点击进入执行线程”一致；右侧任务清单和 `Claude is working` 是截图中可见的线程执行状态。截图没有证明“项目一定要有多个仓库”、线程一定自动开 PR，或任务清单属于独立的项目级任务系统；这些不能由一帧画面推出。

## 对 Tnega 需求对齐的边界

这是外部产品证据，不是 Tnega 需求的自动扩充。若以新版 Claude Projects 为参考，最关键的验收体验应围绕：项目持续对话承接新工作；协调者显式指出交给哪个新/已有线程；用户可从主对话卡片及 Overview 看线程进度并下钻干预；共享上下文和产物独立于单条线程保存。旧版“项目只是聊天文件夹/知识库”不足以表达此形式。官方并未要求 Tnega 复制云托管、GitHub PR、订阅分层或 Claude 的具体状态命名；这些属于实现与产品范围选择。
