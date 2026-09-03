# Agent Eval 与自进化调研

> 日期：2026-09-02
> 目的：为 tnega 下一阶段 coding-agent eval 与自进化设计提供依据。

## 结论摘要

优质项目普遍把 eval 拆成四层：

1. 任务与数据集：固定输入、可控依赖、明确成功标准，支持多 trial 与可复现环境。
2. 执行与 trace：agent 在隔离/沙箱环境运行，完整记录 session、工具调用、步骤、token、成本、延迟。
3. 评分与聚合：结果正确性 + 过程指标（tool selection、efficiency、safety、recovery），代码 grader、LLM judge、人工校准混合使用。
4. 门禁与反馈：回归比较、多 trial 统计、train/validation 分离，把 eval 结果接回自进化或 CI。

自进化项目（DSPy GEPA、dsh 生态、SEAGym 等）共同点是：不直接信任候选的自我宣称，而是用独立 eval 分数 + 失败 trace 反馈驱动变异，且必须防过拟合。

## 一手来源要点

### OpenHands Evaluation Harness

- 把 runtime、sandbox workspace、controller loop、state、security 与 evaluation harness 当作 SDK 核心对象。
- benchmark 集成流程：配置 runtime/container -> 初始化环境 -> 构造 instruction -> `run_controller` -> `evaluate_agent_actions` -> 输出 `EvalOutput`（instruction、test_result、history、metrics、error）。
- `user_response_fn` 模拟用户交互：agent 发送非可执行 MessageAction 时返回预定义回复，避免评测时真人介入。
- 支持多 worker 并行，评测结果输出为 JSONL。

来源：https://docs.openhands.dev/openhands/usage/developers/evaluation-harness

### DeepEval

- 原则：local-first、pytest-native、trace-aware、composable。
- 两种互补模式：test-case based（已知输入/期望）与 trace-based（评分完整执行 trace、span 级指标）。
- 模块：Test case、Dataset、Metric、Trace/Span、Synthetic data。
- 强调 eval 结果同时给人看和给 agent 工具看，形成“跑 eval -> 看失败 span -> 修代码 -> 再跑”的闭环。

来源：https://deepeval.com/docs/introduction-design-philosophy

### Braintrust Agent Evaluation

- Agent eval 测的是多步轨迹：工具选择、参数正确性、中间决策、最终结果，不只是最终答案。
- 非确定性要求多 trial：同一任务多次运行才能得到稳定 pass rate。
- 三类 grader：code-based（字符串/正则/文件/DB/API）、model-based（rubric、pairwise、multi-judge）、human（校准/抽查）。
- 常见指标：task success、tool selection accuracy、parameter correctness、step efficiency、safety、cost、latency、recovery/resilience。
- Task 设计建议来自真实 incident、edge case、领域专家；使用 stub/snapshot 控制依赖稳定性。
- 支持 step-level scorer：通过 hooks 捕获中间 tool call 等 metadata 供下游 scorer 使用。

来源：https://www.braintrust.dev/articles/agent-evaluation

### OpenAI：Eval Skills 方法论

- 从轻量确定性 grader 开始，再补充 rubric 与 LLM judge。
- 每条 skill eval 明确 outcome / process / style / efficiency 四类成功标准。
- 用真实使用中遇到的失败来扩展数据集；trace 可回流成 eval case。

来源：https://developers.openai.com/blog/eval-skills

### dsh-eval（DeepSeek Harness 社区）

- `benchmark.yaml` 定义 model / profile / command / trials / seed / cases / pricing；每个 case 有 prompt、workspace fixture、`expected.tool` 与 `expected.check`。
- 每次 trial 运行在私有临时 workspace + 隔离 `DSH_HOME` + 非交互权限。
- 把持久化 session log 作为 trial trace，从事件流自动统计：task success、tool success、tool-selection accuracy、steps、tokens、context usage、latency、cost、retry、invalid tool call。
- 支持 scripted grading、LLM judge（final answer score + hallucination flag）、paired A/B、keyless replay、跨 harness 导入。
- 报告和 compare 输出 JSON run + Markdown report，compare 使用 signed B-A delta。

来源：https://github.com/hccccc01333/dsh-eval

### DSPy GEPA

- 用 metric 标量 + 文本反馈引导优化，反射模型分析失败样例后提出新的 instruction/prompt。
- 默认只对失败样例反射（`skip_perfect_score`），minibatch 反思、Pareto/current-best 选择。
- 支持 train/validation 分离、budget（`max_full_evals` / `max_metric_calls`）、日志续跑、候选合并。
- 强调格式失败也作为反馈，评估与优化分离。

来源：https://dspy.ai/api/optimizers/GEPA/overview/

### SEAGym 与 harness 效应研究

- SEAGym 把自进化与“token 消耗造成的伪提升”分离，保留 test/replay/cost 记录，用 benchmark task stream 同时测演化与评估。
- coding-agent 领域存在显著 harness effect：同一模型在不同 scaffold 下分数差可达 20%+；报告分数必须固定 model、scaffold、trial 预算与时间戳。

来源：
- https://huggingface.co/papers/2606.17546
- https://futureagi.com/blog/coding-agent-harness-benchmark/

## 对 tnega 的启示

1. **Eval 必须知道“环境”**：coding-agent 评测不是纯 prompt 问答，Task 需要 workspace fixture、setup/teardown、sandbox 权限、验证脚本；run 时 candidate 要真正能读文件、跑命令、改代码。
2. **Evidence 必须是完整 trace**：现在 `Evidence` 只有 `agentResult.messages` 与 artifacts；应加入持久化 session log 的 raw events、tool call/result、turn/step、retry、token/cost/latency，支持 keyless replay 与 trace-level scorer。
3. **多 trial 是必需品**：agent 非确定，单次 run 的 pass/fail 不可靠；Task 支持 `trials`，聚合出 pass rate、score 分布、成本/步骤分布。
4. **评分分三层**：结果正确性（check/assert/文件/git diff）、过程指标（tool selection、无效调用、retry、效率、安全）、LLM judge（rubric + 记录，可 keyless replay）。
5. **自进化要防过拟合**：至少需要 train/validation 任务集分离；gate 增加显著性/回归检查；接受候选基于 val 分，而不是只优化 train。
6. **变异目标不止 system prompt**：coding-agent 的可进化面包括 system prompt、plan prompt、工具集开关、sandbox 权限、maxTurns/maxSteps、skills；先做确定性可评估的一两个面。
7. **运行边界要隔离**：本地优先，每个 task × trial 用私有临时 workspace 和受限工具；不引入 Docker 也能先做，Docker 作为后续选项。
