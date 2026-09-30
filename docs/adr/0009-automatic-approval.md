# 自动审批：独立审查、可信证据和评分决策

> 状态：当前
> 取代关系：无；本轮早期讨论的任务匹配度、0.9 门槛和截断即 ask 方案不再适用
> 当前实现：`packages/approval-review/src/index.ts`、`packages/auto-approval/README.md`、`packages/approval-jev/README.md`、`packages/cli/src/permissions.ts`

## 背景

Auto review 与 Tool Permission、Sandbox 分开：用户可让模型审查需要审批的动作，但不能通过模型判断撤销执行边界。Jev 只输出结构化分类和概率，没有可依赖的自然语言 reason 能力。会话模型与审批模型必须分别配置，审计中的审批模型名不能改写对话路由。

## 决策

- `approval-review` 定义服务；conversation/configured model、Jev、OpenAI 是 Provider；`auto-approval` 是 Consumer。具体 Provider 由 CLI composition 选择。
- Auto 覆盖所有需要审批的工具和 shell 动作，包括依赖安装与 Git 提交；沿用现有无需逐次审批的工具规则。PTC 子调用也走同一守卫。低权限子 Agent 不能使用父 Agent 的自动提权。
- Jev 只询问风险和冲突；风险返回 low/medium/high 及置信度。不再询问任务匹配度、精确授权或文字 reason。
- 当前风险置信度门槛为 **0.85（含）**。低风险冲突概率最多 0.2，中风险最多 0.05；满足置信度的高风险拒绝，置信度不足的高风险转人工。选中类别概率只保存诊断，不是另一个放行门槛。
- `contextTruncated` 仅标记旧证据被预算省略，不能单独导致 ask；当前用户要求或约束超预算、无可信用户任务、无效响应、凭据缺失、失败、超时、取消或模式改变仍转人工。
- 风险判断只评估当前动作本身的后果；任务、约束及路径冲突单独判断。长命令拆解操作，以最高实际风险判断；长度、转义、管道、重定向、环境变量赋值本身不是危险证据。缺编译器、语法错误或之前执行失败本身不是任务冲突；临时目录仍需检查实际边界。

### 输入及持久化

待审批 action 保留准确工具名、原始输入、schema 和 workspace。历史证据预算 24,000 字符，action 16,000，约束最多 8,000。优先保留可信用户请求；带名字的 Agent 请求不能变成用户授权，Project 可信来源由 composition 分类。

保留用户历史指令以承接约束，仅提供当前任务的工具调用记录。整个 `run_code` 源码不作为工具执行事实；PTC 根据当前用户请求之后的 `ptc/dispatch-start` 和 `ptc/dispatch` 配对，提供输入、成功/失败及 shell 退出码。未完成步骤不冒充已经执行。普通 assistant 工具调用仍是调用意图，不能据此证明成功。

工具正文、assistant 推理和系统消息不进入审批证据。历史 `write_file` 正文变为路径、追加标记和字符数等摘要；当前待审批输入不作这种摘要。工具事实不能授予用户授权。

Session 使用独立 `approval/mode` 和 `approval/review` meta。配置解析只认对应配置事件，审计不参与模型/模式选择。旧审计评分保持原值，无需迁移或重写。

## 后果

评分通过只允许继续现有管线，Sandbox 仍独立限制执行。批准针对每个具体调用，不扩展到整段脚本或后续变更的命令。Jev 的阈值失败理由由本地策略生成，只说明触发条件，不伪造模型解释。

Web 不显示 allow 消息；ask/deny 用简短可理解的中文，数字仍保留审计。降低置信度不能消除冲突超限，亦不能保证复杂命令不再 ask。实测效果应基于新后端、新输入的运行记录评估。

## 验证

来源与预算：`packages/auto-approval/test/`。Jev 门槛/失败路径：`packages/approval-jev/test/reviewer.test.ts`。配置隔离：`packages/cli/test/approval-config.test.ts`。权限与 PTC：`packages/cli/test/permissions.test.ts`、`ptc-observation.test.ts`。界面：`apps/web/src/lib/timeline.test.ts`。现场分析见 [修复记录](../fix/2026-09-30-review-ptc.md)。
