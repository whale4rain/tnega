# 多智能体协作产品调研

调研日期：2026-09-24。范围限于公开的一手产品文档；以下“启发”是对文档的分析，不代表已验证的 Tnega 实现方案。产品仍在变化，本文保留当日版本和不确定性。

## Claude Projects 的两个版本

Claude 官方帮助页目前同时介绍旧版 Projects 和新版 beta。旧版以项目知识库和项目指令组织相关会话，也支持组织内共享。新版已从 Claude Code 开始向部分 Pro/Max 用户开放，把一个项目做成持续对话，由 Claude 分出云端并行线程；线程关闭电脑后仍可继续。每个线程从项目资料和记忆开始工作，Library 收集输入文件与产出。旧版知识容器和新版执行协调需要分开讨论。[官方帮助页](https://support.claude.com/en/articles/9517075-what-are-projects)

新版 Projects 中，主对话承担 coordinator，接收工作并把它交给新线程或已有线程。每个线程是独立云端 Session，拥有自己的上下文，代码工作在自己的分支上进行。主对话接收线程报告，不读取其每个执行步骤。用户可以直接进入线程干预；Overview 汇总状态，突出待审阅和等待用户处理的工作。项目记忆以文件保存，与仓库指令分开。它仍是渐进开放的 beta，云端无法直接使用仅存在于用户本机的工具。用户用自然语言给出的并发限制属于模型遵循的指令，并非强制上限。[Projects 文档](https://code.claude.com/docs/en/claude-projects)

启发：项目可以成为长期工作的入口，承接持续增加的任务。产品需要同时表达共享背景、独立执行历史和需要用户处理的事项。总对话适合掌握进展，详细执行过程仍应能下钻查看。

## Claude Code 的 subagents 与 agent teams

subagents 的主要用法是把范围明确的工作交给独立上下文处理，再把结果交回调用者。当前文档也支持具名 subagent 之间发消息，不能继续用“只能向主代理汇报”概括其全部通信能力。Agent teams 则让独立 Session 通过消息协作，有 Task 工具的成员还能共用任务列表，用户可以直接联系成员。官方仍把 teams 标为实验功能；进程内成员无法随 `/resume` 或 `/rewind` 恢复，任务状态可能更新滞后，一个 Session 只有一个 team，lead 不能转移。官方建议将团队用于可以独立开展的调研或跨模块工作，顺序依赖多和同文件修改的任务收益较低。[Agent teams 文档](https://code.claude.com/docs/en/agent-teams)、[Subagents 文档](https://code.claude.com/docs/en/sub-agents)

启发：多代理的独立上下文、成员通信和任务认领是不同能力。团队一旦跨越单次交互，恢复执行和状态一致性就会影响用户能否放心离开。

## Grok Bot

用户写的“gork bot”很可能指 Grok Bot。官方文档描述的 Bot 具有名称和长期职责，可跨会话保留记忆与工作环境；它在持久化云端电脑上使用浏览器、文件系统和终端。有 connector 时使用 connector，其他工作可用 computer use。多个 Bot 可以并行工作，在群聊中共享背景，彼此发消息并移交任务。用户示范的工作流程可以保存成 skill，再按时间执行。[Grok Bot 官方概览](https://docs.x.ai/grok-bot/overview)

官方发布文章将其描述为持续在线的工作团队，并给出工程 Bot 复现问题后交给 debugging Bot 的例子。这能证明产品支持角色间交接；文章没有公开任务交接的事务语义，也不足以证明任意并发改写都能自动解决冲突。[Grok Bot 发布说明](https://x.ai/news/introducing-grok-bot)

启发：如果希望用户反复找同一位成员完成某类工作，长期成员身份与职责记忆会比临时子任务树更突出。共同聊天入口也需要表达谁接手了任务，以及成员拥有的权限。

## Meta Muse

与用户描述最接近的 Muse 是 Meta 于 2026 年 9 月发布的个人 Agent。它把长期目标转为行动计划，能关闭 App 后继续工作，也会在需要批准时回来询问。官方同时介绍了系统层隔离的 Sentinel agent，用于审查对外动作；敏感操作需用户确认。公开材料支持“持续运行的个人代理”和“执行与监督分工”，没有足够依据将它描述为用户可以组建的通用多角色团队。[Meta Muse 发布说明](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)

Muse 产品页强调持续跟踪目标，提供提醒与监控，并允许用户按连接配置操作权限。[Muse 产品页](https://ai.meta.com/muse/)

启发：一个产品可以保留单一对话身份，在后台分工执行。用户关注的是目标是否推进、何时需要介入；是否把所有成员展示出来，是可单独选择的产品方向。监督代理的存在也不应替代系统权限边界。

## Tnega 当前基础

本节基于调研开始时的提交 `4191cde`，属于代码阅读结论，未运行产品实测。

| 已有能力 | 当前边界 | 对方向选择的影响 |
| --- | --- | --- |
| Subagent 独立 Session、durable inbox、spawn/fork 与恢复 | 消息只允许相邻父子互发；共享 Workspace；默认并发上限 3、深度 2 | 已适合主 Agent 委派任务；平级团队需要新的成员与通信语义 |
| 子代理创建及恢复 | Local Provider 使用统一的 LLM adapter 和子代理 system prompt，start 请求没有逐角色模型/工具配置 | 多模型选择已有系统级基础，长期专业角色仍需单独定义配置归属 |
| Workspace Memory | 全局与 Workspace 各限 4,000 字符；Workspace 内容用于长期约定；下次 Agent Run 读取 | 适合共享背景，不适合承担任务状态或全部协作记录 |
| Session 与请求记录 | 模型可见历史须可从 durable Session 重建；请求保存上下文快照 | 跨 Agent 决策和交接进入模型时，也要留有可追溯的记录 |
| Web resident Agent 与 Goal | resident 路径仍在 SSE close 时 abort 本次 Run；Goal 在一次 Run 内有界推进 | 可恢复与后台常驻是不同能力，长期目标需要补运行生命周期 |
| Eval 与 coding runner | 已有策略、证据、判定和隔离评测；当前 codingRuntime 未组装 subagent 服务 | 有验收基础，但不能声称现成评测已覆盖完整多 Agent 协作 |

以上边界可从以下代码与文档核对。

- [Subagent 约定](../../packages/subagent/README.md)、[服务契约](../../packages/subagent/subagent/src/index.ts)、[本地实现](../../packages/subagent/subagent-local/src/index.ts)。
- [Memory 约定](../../packages/memory/README.md)、[Session 不变量](../../packages/session/README.md)。
- [Web Run 生命周期](../../packages/cli/src/server.ts)中的 `runResidentTurn`、[CLI 组合能力](../../packages/cli/README.md)。
- [Eval 能力](../../packages/eval/README.md)、[codingRuntime](../../packages/eval/src/codingRuntime.ts)。

产品层的“项目”也需要与当前 Workspace 区分。按 [CONTEXT.md](../../CONTEXT.md)，Workspace 是一个绝对路径目录。若项目未来包含多个仓库，或跨越多个 Workspace，它应有独立语义；本次只指出边界，不决定领域模型。

## 方向比较

以下是结合产品调研与仓库能力提出的判断，不代表外部产品已经采用同样实现。

| 方向 | 用户围绕什么组织工作 | Tnega 的适配程度 | 主要代价 |
| --- | --- | --- | --- |
| 项目主会话统筹 | 一个持续推进的项目 | 现有父子委派最接近，优先考虑 | 项目状态、任务依赖与产物归属；并行文件变更的集成 |
| 长期专业 Agent 团队 | 可以反复委派工作的固定成员 | 可复用 live Agent、Session 与 profile | 身份跨 Session 延续、角色配置、平级协作与知识边界 |
| 长期目标驱动 | 持续数天或更久的目标 | 可复用 Goal、恢复与 Memory | 后台调度、唤醒与停止条件；无人在线时的权限和预算 |
| 产物与验收驱动 | 可交付且可验证的结果 | 最贴近 eval-first 定位 | 验收依据、独立验证及返工边界；把多 Agent 纳入评测 |

### 项目主会话统筹

用户把持续出现的需求交给一个项目主会话。协调 Agent 决定哪些任务可并行，哪些要等待；用户能查看工作分支，也能直接纠正某项任务。

新版 Claude Projects 是最直接的参考。Tnega 已有父子委派关系，沿这个方向发展可以保留现有执行习惯。新增价值在于跨任务维护进度，把产物与决策积累在项目中，并减少用户在不同 Session 之间转述背景的工作。

主要缺口是项目级任务状态和依赖关系，以及并行修改的整合。当前子代理共享 Workspace，只靠任务描述约定互不重叠，不能据此保证文件隔离。协调 Agent 也可能成为瓶颈，过度摘要会遗漏细节。

适合以 coding 和研究任务为主、希望先获得完整协作体验的 Tnega。四个方向中，我最倾向把它作为产品主线。

### 长期专业 Agent 团队

用户保留一组长期成员，例如研究 Agent 和代码审查 Agent。职责与经验随成员保留，每次任务结束后，下次还能继续委派给同一成员；需要时成员之间交接工作。

Grok Bot 的固定成员及群聊协作可作为参考。Tnega 的 live Agent 和 durable Session 提供运行基础，profile 可以承载部分组合配置，但长期成员的身份与记忆归属还没有等价产品对象。当前子代理也使用统一的 adapter 与 system prompt，尚不能把系统支持多个模型等同于每个角色可独立选择模型。

这个方向的收益取决于职责是否长期稳定。重复研究、持续审查及固定业务流程更适合它；一次性任务未必需要维护一整套角色。直接互发消息会增加重复工作和消息循环的风险，团队成员的职责边界会成为主要设计问题。

### 长期目标驱动

用户交付一个长期目标，系统在需要时组织 Agent 工作，保存中间结果，等待条件变化，再继续推进。用户主要处理少量判断和验收。

Muse 的持续目标与后台推进值得参考；其公开的 Sentinel 属于独立安全监督角色，不能据此推断 Muse 向用户开放了与 Grok Bot 相同的多成员团队。

Tnega 已有 Goal 和恢复能力，但当前 Goal 依附 Session，并在一次 Agent Run 内有界推进。Web 断连也会取消当前 Run。走这个方向需要把工作持续性与界面连接分开，并明确何时唤醒、何时停下、如何限制总预算。

它适合持续研究或长期软件维护，工程跨度较大。后台驻留本机只能保证界面关闭后继续运行；电脑关机后仍执行，需要远端常在线环境。部署地点是独立选择，不必与多 Agent 产品形态同时决定。

### 产物与验收驱动

用户先描述需要交付的结果及验收条件。多个 Agent 围绕同一产物分工，有的产出候选，有的检验证据；失败项回到明确的修改范围，通过验收的结果才进入交付。

Tnega 的 Eval-first 定位最适合支持这个方向。已有 Evidence / Verdict 和 coding trace 可以帮助回答“这次协作交付了什么、为何算完成”，也能比较协作方式，而不仅是展示各 Agent 正在做什么。

主要难点是验收本身的质量。代码任务可以依靠测试与行为证据；研究和创作往往还需要人工判断。多个 Agent 使用相似上下文和模型，也可能一致犯错，因此互相赞同不能替代独立证据。当前 coding eval runtime 仍需补齐多 Agent 组合与协作指标。

这个方向适合质量要求明确的 coding 或研究交付，也可以与项目主会话结合，作为它的完成标准。

## 倾向与选择依据

建议以“项目主会话统筹”为产品主线，把“产物与验收驱动”用于判断任务是否完成。前者贴近现有父子 Subagent，后者延续 Tnega 的 Eval-first 定位。固定角色可以在出现稳定分工后加入；长期自主推进则取决于是否确实需要无人在线的工作。

这些方向可以组合，但分别改变了工作如何组织和 Agent 身份如何延续，也决定执行持续多久，以及什么算完成。第一轮产品探索最好选定一个主轴，避免同时引入过多长期状态。

验证方向时，应拿同一组代表任务比较单 Agent 与协作运行，控制模型条件并报告总预算。至少观察交付通过率和用户干预次数，同时统计耗时和 token 成本，再记录冲突与重复工作的情况。这些指标将作为后续决策依据，本次尚未测量实际效果。

Anthropic 的多 Agent 研究经验指出，广度探索和可独立并行的信息工作更容易受益；高度依赖共享上下文的任务协调成本更高。其报告的 token 倍数来自特定研究系统，不能直接作为 Tnega 的预算估计。[官方工程文章](https://www.anthropic.com/engineering/multi-agent-research-system)

本次只完成方向调研，没有设计 API、事件 schema 或实施步骤，也没有修改运行时代码。
