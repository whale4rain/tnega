# Coding Harness 机会调研（2026-09）

> 调研日期：2026-09-24  
> 范围：Tnega 当前实现、Codex、Claude Code、Pi、DeepSeek Harness、论文资料与小红书公开检索。  
> 判断原则：功能存在与否以当前仓库和一手来源为准；“官方材料未说明”不等于“产品没有”。

## 结论

Tnega 已有相当完整的实验底座：插件生命周期和能力缝、JSONL Session、coding agent、Plan/Goal、MCP 与 Skills、权限审批、Subagent、记忆、coding eval 多 trial、trace 指标及候选 gate。Eval 和 evolve 已是现实能力，不是路线图设想。相关实现见 `packages/eval`、`packages/evolve`、`packages/agent`、`packages/coding-agent`、`packages/cli`。

主要差距不在于再加一套常见 Agent 功能。DeepSeek Harness 已覆盖插件组合、goal、workflow、sandbox 和 trajectory replay；Claude Code 与 Codex 也公开了成熟的 hooks、权限、子代理和隔离运行能力。建议 Tnega 把现有 Eval 能力延伸到“可审计的软件变更交付”，并把评测对象从 prompt 候选扩展到完整 Harness 配置。可优先推进以下方向：

1. **可审计的变更证据包**：让每次 coding Agent Run 输出机器可核查的变更记录，关联初始提交、任务约束、工具与权限事件、patch、运行过的验证命令及结果、最终判定。现有 eval 已存 Session trace、trial、成本与步骤指标，也能跑 workspace check；下一步应把验证覆盖率、失败归因和证据摘要纳入统一产物。
2. **基于 Eval 的 Harness 配置演化**：让 experiment candidate 能比较 prompt、tool set、policy、skills、plan 策略和模型路由组合，仍由隔离运行和确定性 gate 决定是否接受。Tnega 已有候选、实验树和 gate；新价值在于评测并演化完整配置，而非只做提示词改写。
3. **子代理的变更协调与隔离**：目前 Subagent 共用 Workspace，README 要求调用方避免写入范围重叠。可增加任务级文件范围声明、冲突探测、变更集暂存和父 Agent 集成前验证，减少并行写入污染。先以逻辑隔离和变更审查落地，再评估 worktree/provider 作为替换实现。
4. **安全策略的耐久审计与策略回放**：当前 Tool Permission 会逐次批准越权调用，工具策略负责执行边界。可把策略输入、判定依据、批准人类动作、实际副作用和恢复结果纳入 Session/Eval 证据，构造权限回归集，验证策略升级不会扩大可执行范围。Tnega 文档明确指出 Shell 没有系统级沙箱；OS/container sandbox 是更大的后续工程，优先补策略语义和 fail-closed 验证。
5. **跨 Harness 的可复现比较格式**：把 Session trace、模型及配置快照、工具调用、workspace 初始状态、patch 和验证结果导出为可脱敏的 episode bundle，便于复跑和比较不同 Harness。论文提出公开 Thought-Action-Result 轨迹有助解释与复现；这可以成为 Tnega 的工具和社区数据格式，而不只是自己的仪表盘。

前两项与 Tnega 的 Eval-first 定位最吻合，也较容易复用当前代码。第三项对应真实的多 Agent 协作边界。第四项是可靠性基础。第五项可在前几项的 schema 稳定后推动。

## Tnega 当前能力基线

| 领域 | 仓库可确认的能力 | 对方向判断的影响 |
|---|---|---|
| 核心运行时 | Fiber 生命周期、卸载逆序撤销、Service / Provider / Consumer 能力缝、Agent Loop 替换点 | 插件化不是空白，差异应落到生命周期不变量的测试与使用体验 |
| Session / Agent | JSONL durable Session、持久 inbox、Session 恢复、可重连 assistant stream；模型可见历史要求从 durable 事件重建 | 可在既有轨迹上附加验证与安全证据 |
| Coding UX | Auto / Plan / Goal、skills、stdio MCP、slash commands、权限预设与一次性人工审批 | 常见交互功能已覆盖；Execute 已不再作为当前公开模式 |
| 多 Agent | Subagent 独立 Session 和 durable inbox，支持 spawn/fork、恢复和有限并发；共用 Workspace | 变更冲突管理和更强隔离是可识别的实用缺口 |
| Eval | workspace fixture、setup/check/teardown、trial、工具权限、session JSONL trace、步骤/成本/错误/重试指标、trial 聚合 | 不是从零开始。证据包可基于 coding runner 扩展 |
| Evolve | experiment tree、候选隔离评测、regression/safety gate、人工审批 | 可拓展 candidate schema 和可比较的 Harness 维度 |
| 安全 | 路径约束、工具 policy、只读/工作区写入/bypass 预设；Shell 越权会请求批准 | Shell 无操作系统级沙箱；当前可先加强审计、回归和隔离 provider |

以上以当前 `CONTEXT.md`、各 package README 及源代码为准。尤其 `packages/eval/src/runner.ts` 会为每次 trial 创建 workspace、Session trace，并记录 verdict 和 trace metrics；`packages/evolve/src/types.ts` 已持久化候选和每轮 EvalRun。新增方向不能重复建设这些底层能力。

## 竞品对照：能确认什么

### Codex

OpenAI 官方文档列有本地和托管运行、Sandbox、Git worktree、Hooks、Subagents、MCP、Record & Replay、非交互模式和 Codex SDK。Codex 产品及 Agents 文档说明了异步任务、会话管理、多 Agent 与多种 Sandbox 运行方式。**因此，审批、隔离环境、事件钩子、多代理和会话续跑都不能作为 Tnega 的竞品空白。**公开文档未能确认 Codex 是否支持像 Tnega `evolve` 这样的用户可组合 Harness 候选评测闭环；将其视为机会假设，后续应通过实测验证。

来源：[Codex CLI / 产品文档](https://learn.chatgpt.com/docs/codex/cli)、[Codex Hooks](https://developers.openai.com/codex/hooks)、[Subagents](https://developers.openai.com/codex/subagents)、[Record & Replay](https://developers.openai.com/codex/record-replay)、[Sandbox Agents](https://developers.openai.com/api/docs/guides/agents/sandboxes)。

### Claude Code

Anthropic 文档列有 Hooks、Subagents、Memory、权限规则与团队工作流。Hooks 可在工具执行前后、子代理和压缩等生命周期接入处理器，并允许阻断工具调用。**Tnega 的插件语义不能只用“有 hooks”或“有插件”来区分。**可以用可测试的不变量说明实现价值：插件注册归属 Fiber、dispose 完整撤销副作用、Session 能重建模型上下文，以及候选变更通过 Eval gate。

来源：[Claude Code 文档](https://code.claude.com/docs/en/overview)、[Hooks](https://code.claude.com/docs/en/hooks)、[Subagents](https://code.claude.com/docs/en/sub-agents)、[Memory](https://code.claude.com/docs/en/memory)。

### Pi

Pi 官方文档提供 Session 分支树、Compaction、Extensions、SDK、RPC 和可定制权限扩展。其官方 README 将若干能力明确留给扩展或用户组合，包括 MCP、权限弹窗、Plan、内置待办、后台 Bash 和子代理。它既是最小核心范例，也能通过包和扩展补齐工作流。Tnega 的可比价值可以是开箱即用的 Goal、Eval 和 durable Session 语义；“Pi 不支持某功能”的说法应限定为其核心 README 的声明。

来源：[Pi README](https://github.com/earendil-works/pi)、[How Pi Works](https://pi.dev/docs/latest/how-pi-works)、[Sessions and Context](https://pi.dev/docs/latest/sessions)、[Extensions](https://pi.dev/docs/latest/extensions)、[SDK](https://pi.dev/docs/latest/sdk)。

### DeepSeek Harness

DeepSeek 官方把模型、工具、Skills、Session、Sandbox、Storage、Loop、调度和 UI 列为可插拔能力；官方版本也包含 goals、workflows 和多种 Runtime Mode。官方 Session 文档描述 append-only 事件和 Trajectory 的 resume、fork、search、replay。其仓库还提供 keyless LLM replay 测试插件。**插件化、Goals、Session replay 和多 Agent workflow 已有直接竞品覆盖。**Tnega 应围绕语义可验证性、可复现 Eval 和候选变更门禁竞争。

来源：[DeepSeek Harness 官方介绍](https://www.deepseek.com/harness/en/)、[GitHub 仓库](https://github.com/deepseek-ai/deepseek-harness)、[Session subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)、[Goal](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/goal)、[Workflow](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/workflow)、[LLM replay 插件](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/test-support/llm-replay)。

## 论文给出的设计依据

- **轨迹公开与结果解释**：Li 与 Storhaug 对 18 篇软件工程 Agent 论文的分析指出，Agent 版本、提示、温度和随机性都会影响评测结果；他们建议公开 Thought-Action-Result 轨迹或其摘要，便于复现和比较。来源：[FSE Companion 2026 / arXiv](https://arxiv.org/abs/2604.01437)。
- **Harness 与环境共同决定可靠性**：Zhong 与 Zhu 提出 H0–H3 Harness 能力层级和 trace-based episode package，记录 action、tool、context、verification、failure attribution、intervention、entropy 和 outcome。该框架与 Tnega 已有 trace/Eval 最接近，缺口主要在证据组织与结果可审计性。来源：[AI Harness Engineering](https://arxiv.org/abs/2605.13357)。
- **开放挑战**：Ning 等人的综述提出，评测不能只看最终成功，还应处理反馈不完整时的验证、Harness 改进的回归风险、多 Agent 共享状态一致性及人工监督。来源：[Code as Agent Harness](https://arxiv.org/abs/2605.18747)。
- **系统级可靠性**：Jarmak 的 2026 年技术综述把任务构造、执行环境、检索、状态、验证、权限、审查界面和资源分配放在一条可靠性链上，并强调单层指标改善未必传导到端到端结果。来源：[Engineering Reliable Coding Agents](https://arxiv.org/abs/2608.13867)。

这些工作提供设计依据和研究问题，不能直接证明某项产品路线会提高真实用户效率。建议以真实失败 trace 建 Eval case，固定模型、版本、任务、预算和 workspace 后做对照实验。

## 小红书检索记录与边界

本次以“小红书 + Codex / Claude Code / coding agent / harness”等词做公开网页检索，没有拿到可稳定打开、可核实作者与发布日期的小红书原帖。检索到飞书转载的一篇实践介绍，称其来自小红书博主，主题是把本地 Claude Code 和 Codex 接入飞书并管理多 Session；这只能算一个值得验证的工作流信号，不能代表平台用户的普遍需求。[飞书转载](https://www.feishu.cn/content/article/7647408304896953549)

搜索引擎未返回结果不代表平台上没有相关讨论；小红书客户端内的登录态搜索、评论区与近期笔记未纳入本次资料。故本文不把论坛转述或无法回链的帖子写成用户研究结论，也不据此声称开发者普遍遇到某类痛点。

下一轮如需把小红书作为需求证据，应在平台内抽样近期笔记和评论，保留原链接、发布日期、互动量、观点摘录及样本选择规则；对高频问题再转成 Tnega eval task，验证其是否影响真实任务成功率。

## 建议的落地顺序

1. **Episode 证据包（第一优先）**：定义版本化 `Episode` schema，固定起始提交、模型/配置哈希、任务、权限、Session trace、diff、验证命令与退出状态。支持本地导出和脱敏，并能从 bundle 复查判定。先用现有 workspace runner 生成。
2. **验证充分度指标**：记录任务要求与验证命令的对应关系，区分“补丁通过已有测试”与“目标要求被覆盖”。对没有跑验证、验证失败或人工批准的情况生成明确标签。通过故意缺测和回归 fixture 验证判定不会把未验证标为完成。
3. **Harness profile 候选评测**：将 Agent prompt、coding-agent 配置、工具集/policy、Skills 开关纳入 CandidateSnapshot；在 train/val 分区与多 trial 上比较，再走现有 safety/regression gate。先不自动探索复杂执行代码或权限提升。
4. **Subagent 变更集**：给子任务声明可写路径；结束时保存其 diff 与触碰文件，父任务合并前运行重叠检查和局部验证。实现以 provider seam 保留目录、Git worktree 或容器等运行方式的替换空间。
5. **跨 Harness bundle 与基准**：为 Tnega、Codex、Claude Code、Pi、DeepSeek Harness 定义最小公共 episode 导入/导出适配器。把公平比较作为研究工具，公开配置和轨迹时默认脱敏 prompt、文件内容、路径与凭据。

## 后续验证问题

- Codex、Claude Code 的公开产品能力持续变化；“未发现用户级 Harness 变更自动评测闭环”需要用当前版本实测，不能写成确定缺失。
- Tnega 的 Shell 当前没有 OS sandbox。若主打严格隔离，需要先选 Windows/Linux/macOS 的具体执行 Provider 和安全边界，再测路径穿越、子进程、网络与取消。
- Subagent 变更隔离要先确定范围：文件级租约、Git worktree，还是容器。文件级租约实现较轻，但无法阻止 Agent 通过 Shell 越界写入，需与执行层策略结合。
- 论文中的能力框架和小红书用户反馈属于不同证据类型；前者支持系统设计问题，后者若补采样才可支持目标用户选择。
