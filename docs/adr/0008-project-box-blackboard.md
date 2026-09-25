# Project 协作从任务运行时转向 Box、Blackboard 与 Project Loop

> 状态：已采纳的设计目标；尚未在 `main` 实现
>
> 取代关系：取代 [旧版 Project 协作运行时设计](../superpowers/specs/2026-09-24-project-collaboration-design.md)及其[实施计划](../superpowers/plans/2026-09-25-project-collaboration-implementation.md)
>
> 当前设计：[Project v2 设计框架](../superpowers/specs/2026-09-25-project-box-blackboard-design.md)

日期：2026-09-25。此 ADR 记录产品与架构的选型变化，不表示新运行时、数据迁移或 Web 界面已经交付。旧版实现位于 `codex/project-collaboration` 分支；`main` 此次只接收设计文档。

## 背景与决策经过

[2026-09-24 的调研](../research/2026-09-24-multi-agent-products.md)已经区分旧版知识库式 Claude Projects 和 2026 年 9 月的新版：一个持续的主对话协调独立线程，用户可以进入线程干预，Overview 汇总状态。因此旧决策的问题并非没有查到新版产品。调研推荐“项目主会话统筹”，也指出 Tnega 的 Session、durable inbox、Subagent 和 Eval 可作基础。

随后旧设计把 Project 定义为 `Project → Thread → Execution → Session → Agent Run`，以 Project Log 的命令、状态归约和 outbox 管理任务、提交、审阅与恢复。这个结构适合有明确交付和验收条件的有界工作，也能把评测证据接到产物上。但它在产品交互稳定前，就把“任务怎样提交并验收”变成了所有 Thread 的共同协议。

用户后来明确的目标是：Project 只凭名称创建，长期承接混合工作；主对话始终可继续接收消息，用户与模型消息无需轮换；协调 Agent 自行组织不同模型、工具的子 Agent；用户可直接进入 Thread；普通工作可以自然结束，结果和可编辑记忆进入 Project。新版界面以主对话中的 Thread 卡片为入口，Overview 是按需打开的状态视图。详见[产品对齐记录](../superpowers/specs/2026-09-25-project-product-realignment.md)和[新版产品调研](../research/2026-09-25-claude-projects-redesign.md)。

这些不是给旧状态机补几个字段就能解决的差异。要改变的是 Project 中“消息、身份、共享事实、执行”的主次关系。

## 旧选型的问题

| 旧决定 | 遇到的具体场景与问题 | 本次修正 |
| --- | --- | --- |
| Thread 是任务；改派、profile 变化或清空上下文可新建 Execution 和 Session。 | 用户从卡片再次进入同一 Thread 补充要求时，产品上期望找到同一个可继续交谈的 Agent；内部却可能切换为另一段 Session。Thread 身份与模型历史的关系需要额外解释和交接。 | 一个 Thread 对应一个稳定 Agent 身份、一个文件夹和一个 Session；Agent Run 表示该身份的一段执行。需要不兼容的全新上下文时创建有来源链接的新 Thread。 |
| Worker 必须 `thread_submit`，进入 `awaiting_review`，由协调者验收；普通回复未提交还会触发格式补救或失败。 | 研究发现、简短答复和持续协作不一定有可审阅的“提交物”。把 Eval-first 解释成每件事都必须经过验收，会迫使 Agent 为自然结束的工作制造流程，界面也被等待验收占据。 | Eval 与 Review 在需要证据或用户明确要求时启用；自然语言结果可以直接回报父 Agent 并写入共享事实。Eval-first 保留为可测量的质量机制，而非所有对话的完成门槛。 |
| Project Service 的命令、Project Log 和 outbox 承担用户指令、线程控制、报告、审批等多条路径。 | 用户连续发言、协调者主动简报、子 Agent 回报、用户直接给 Thread 留言，都是同一种跨参与者消息。旧协议可分别实现这些动作，却缺少一个共同的消息信封、收件箱和因果关系作为产品时间线的基础；每加一种发言关系就要穿过不同命令与投影视图。 | 所有参与者共用 Box。Box 负责投递，Blackboard 持久化信封与收件状态，各 Agent 的 Session 只记录自己实际接纳的模型历史；`causationId` 连接要求、Thread 卡片与结果。 |
| 先定义固定 WorkerProfile，并以内置 Research、Coding、Reviewer 等角色组织第一期能力。 | 协调 Agent 被限制在预设角色及其创建路径里；混合资料、临时专项工作、不同模型与专业工具的组合要不断扩展角色表。角色名还容易被误认为业务身份。 | 不在代码中枚举子 Agent 类型。父 Agent 从宿主允许的模型、工具 bundle 和资源目录组成配置，由 Project 权限、预算和能力校验约束。 |
| 第一期一个 Project 绑定一个源 Workspace，以代码工作树和隔离集成为默认起点。 | 用户只输入名称就想开始项目，也可能先做文章、检索或整理资料，之后才加入仓库。必需 Workspace 使创建流程和领域模型都偏向 coding。 | Project 有独立身份，可后续添加仓库、文件和资料；代码 Thread 在确实需要时获得隔离 worktree 和目标分支。 |
| UI 设计虽写到主会话和直接干预，却以任务状态、产物、审阅为主要入口；旧版分支的 `ProjectOverview`、`ProjectChat` 等页面沿此组织。 | 这与截图中的“主对话中就地出现 Thread 卡片、侧边展开 Thread、Overview 可选”不同。用户反馈旧前端基本不可用；这是产品对齐反馈，不是性能或可用性测试结论。仅调整页面名称和样式不能修复信息架构。 | Web 以持续主对话为默认屏，Box 投影消息，Blackboard 投影卡片与 Overview，Agent Session 投影 Thread 详情；Memory 和 Library 分别提供可编辑记忆与资料产物入口。 |

更深一层的失误是决策顺序。旧计划在主对话中“用户可以连续发言、Thread 如何就地出现、直接干预怎样回流协调者”等交互语义尚未成为验收场景时，先写下了完整的任务状态机、持久化协议和分阶段实现计划。研究方向是对的，架构却被有界任务与 coding 交付的强约束牵引。它不是单一组件的代码质量问题，也不能简单归因于“过度设计”：隔离、幂等和可追溯性本来就需要设计；问题是这些机制服务了错误的首要抽象。

## 保留的判断

旧设计对故障和权限边界的处理仍有价值：单 Agent Loop 不承担跨 Agent 唤醒；Session 是模型可见历史的真源；消息接纳需要持久化与幂等；不同 Agent 的模型、工具和文件系统应按作用域隔离；共享产物需要来源与版本；代码分支集成不能靠多个 Agent 改同一个工作目录。这些继续作为 v2 的约束。旧设计中 Thread 依赖关系与父子关系分开记录，也保留到 Blackboard 中。

旧版的 Project Log 与 Execution 对任务式工作有解释力，但不能作为 v2 的通用身份和消息协议。旧数据不可按新事件含义直接重放。

## 考虑过的路径

1. **保留旧运行时，只重做 Web。** 改动较小，但消息仍分散在命令、outbox 与 Session，Thread 仍可能有多个 Execution/Session；新的主对话只是旧任务模型的另一种外观。
2. **在旧运行时旁边补统一消息层。** 能复用部分状态机，但会同时存在 Project 命令消息和 Box 消息两套入口及确认语义，故障恢复和 UI 投影很难确定唯一来源。
3. **用 Box、Blackboard 和 Project Loop 重定协议，复用底层机制。** 要重做 Project 协议与前端，迁移成本最高；它让消息、共享事实和 Agent 身份分别拥有明确的真源，能够表达所需的持续交互。选择此路径。

## 决策

Project Loop 是高于现有 Agent Loop 的独立插件，负责子 Agent 生命周期、Box 消费、唤醒、恢复与父子回报；Agent Loop 继续处理单个 Agent 的模型与工具调用。一个 Agent 有稳定文件夹和唯一 Session。根 Agent 是主对话的协调者，其他 Agent 形成可追溯的父子树。父 Agent 可创建下级 Thread；兄弟间默认经父 Agent 和共享引用协作，直接通信需显式授权关系。

Box 是用户、协调 Agent 和子 Agent 共同的消息通道，提供窄接口和至少一次投递；信封、确认状态及因果关系由 Blackboard 持久化，Session 以消息 ID 去重并记录已接纳输入。Blackboard 是项目共享事实的真源，保存记忆版本、Agent 关系与状态、资料和产物引用。完整对话属于各 Agent 的 Session，大文件属于 Artifact Store。用户可查看和修改 Project 记忆，修改留有版本与来源。

各组件独立成包与插件：`packages/loop/project-loop`、Project 身份、Box、Blackboard、Thread 生命周期、Artifact Store，以及各自的 Provider 和模型可见 Consumer。Provider/Consumer 依赖服务定义，遵守 [能力缝 ADR](./0006-capability-seams.md)。Project Host 负责装配，不另建第二份业务状态。具体包边界、投递与恢复规则见[v2 设计框架](../superpowers/specs/2026-09-25-project-box-blackboard-design.md)。

对外发送邮件、发布等动作仍需用户授权；在用户指定仓库和目标分支范围内的内部合并可由 Agent 直接完成。超出用户目标的后续工作由协调 Agent 提议，不能自动扩展范围。

## 后果与迁移边界

这项决定会使旧分支中的 `project-runtime`、Project Log/Execution/固定 WorkerProfile 协议及旧 Web 页面需要重做，不能把旧实现合并到 `main` 当作 v2。既有 Core、Agent、Session、durable inbox、权限和隔离执行代码应按接口与行为逐项复用，而不是整体丢弃。

新旧持久化格式分开。旧项目若已有数据，先提供只读或导出；只有字段和事件语义映射确定后才实施显式迁移。v2 的验收首先覆盖连续用户消息、父子并行投递及去重、崩溃恢复、直接干预 Thread、可编辑记忆和界面重连后的消息/卡片一致性。后台跨关机运行和基于评测自动演化专业能力仍是后续议题，不作为这次设计已经完成的能力。
