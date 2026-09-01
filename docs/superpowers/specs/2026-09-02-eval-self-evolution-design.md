# Eval 与自进化设计

> 日期：2026-09-02
> 状态：待用户审阅
> 分支：codex/dsh-align
> 目标版本：下一版本核心能力，版本号在发布时确认

## 1. 背景与目标

tnega 已有通用 agent eval（`packages/eval`）和实验性自进化（`packages/evolve`），
但当前 eval 只能跑纯 prompt 问答，无法评测 coding-agent 的真实工作能力：
没有 workspace fixture、没有真实工具执行、没有完整 trace、没有多 trial 聚合。
自进化目前只做 system prompt 变异，缺少 train/validation 分离、失败 trace 反射和可靠门禁。

本期目标：

1. 在 eval 层扩展 coding-agent 评测，使 candidate 能在隔离的私有 workspace 中真实
   读写文件、执行白名单命令、运行测试。
2. 严格控制评测过程中的权限：工具白名单、路径沙箱、shell 命令白名单、默认禁网。
3. 完整记录 trace，支撑 trace-level 评分、LLM judge 和失败反馈。
4. 支持多 trial 聚合与 train/validation 分离，使评测结果可比较、可回归。
5. 让自进化基于 eval 数据闭环：失败 trace 反射 -> 变异 -> 全量评测 -> 门禁 -> 实验日志。

## 2. 非目标

- 不引入 Docker / 容器沙箱；权限控制通过进程内工具层实现，后续可再加容器层。
- 不修改 coding-agent 的内部执行逻辑；只增加最小可选配置注入（system prompt、
  plan prompt），默认行为不变。
- 不做 Web 仪表板（本期只做库 API + CLI + 机器可读产物，Web 下一期消费这些数据）。
- 不做完整显著性检验（本期门禁用 `minPairs + minDelta + regressions`）。
- 不做独立消费插件（沿用 DSH 对齐时确定的范围）。

## 3. 总体架构

采用方案 A：在 `packages/eval` 内扩展 coding runner，不新建包、不依赖 CLI。

```text
tasks.yml / EvalRunOptions
        |
        v
EvalService.run()
        |
        v
CodingEvalRunner (packages/eval)
  |-- per task x trial: mkdtemp workspace + fixture copy
  |-- CodingRuntime (eval 内部组合 session/tools/agent/coding-agent)
  |-- ToolPolicy: whitelist + path sandbox + shell allowlist + truncator
  |-- session raw log -> trace file (run 目录，workspace 之外)
  +-- scoring: check/assert + trace metrics + optional llm-judge
        |
        v
EvalRun (verdicts + trials + summary + trace refs)
        |
        v
EvolveService (packages/evolve)
  |-- diagnose(train failures) -> failure modes + trace excerpts
  |-- llm propose rule -> candidate patch (coding config)
  |-- evaluate(train + val) -> gate -> accept/reject
  +-- experiments/log.json DAG
```

依赖方向：`evolve -> eval -> coding-agent/agent/session/tools`，CLI 只做编排和格式化。
`packages/eval` 不依赖 `packages/cli`，避免循环依赖。

## 4. Task Schema 扩展

在 `packages/eval/src/types.ts` 中扩展 `Task`：

```ts
export interface EvalWorkspaceFixture {
  /** 相对 tasks 文件的模板目录；复制到私有 workspace。 */
  root?: string
  /** 显式文件清单；content 或 from 二选一。 */
  files?: Array<{ path: string; content?: string; from?: string }>
}

export interface EvalShellPolicy {
  enabled: boolean
  /** 命令首词/前缀白名单，例如 ["pytest", "npm test", "pip install", "node"] */
  allow?: string[]
  /** 高危命令黑名单，例如 ["rm", "shutdown", "taskkill"] */
  deny?: string[]
}

export interface TaskPermissions {
  /** 工具白名单，省略时使用安全默认集。 */
  tools?: string[]
  /** shell 策略，默认禁用。 */
  shell?: EvalShellPolicy
  /** 网络工具，默认 false。 */
  network?: boolean
  /** skills 工具开关，默认跟随 candidate 配置。 */
  skills?: boolean
  /** MCP 始终 false（本期不支持评测中启用 MCP）。 */
  mcp?: boolean
}

export interface Task {
  // ...现有字段
  fixture?: EvalWorkspaceFixture
  /** 初始化命令（在 workspace 内执行）或 hook。 */
  setup?: string | ((workspace: string) => void | Promise<void>)
  /** 成功判定：命令（exit 0）或 predicate。 */
  check?: string | ((evidence: Evidence, workspace: string) => boolean | Promise<boolean>)
  /** 清理/收尾命令或 hook。 */
  teardown?: string | ((workspace: string) => void | Promise<void>)
  /** 默认 3；必须 >= 1。 */
  trials?: number
  permissions?: TaskPermissions
  /** 默认 'train'。 */
  split?: 'train' | 'val'
}
```

行为约定：

- `trials` 缺省为 3；每个 trial 使用独立 workspace 和独立 session trace。
- `split` 缺省为 `train`；只有标记为 `val` 的任务进入门禁比较。
- `fixture.root` 复制时保留目录结构；所有 fixture 文件只读复制，agent 修改的是副本。
- `setup` 在 agent 启动前执行；`check` 在 agent 结束后执行；`teardown` 无论成败都执行。
- check 命令输出写入 verdict 的 `output`，作为失败原因的一部分。

## 5. 权限模型

权限是本期最核心的约束，分三层：

### 5.1 工作区隔离

- 每个 `task x trial` 通过 `mkdtemp` 创建私有 workspace，fixture 复制进去。
- coding runtime 的 `cwd` 固定为该 workspace；agent 无法通过工具参数指定其他目录。
- session trace 文件写在 run 目录（`runs/<runId>/traces/`），位于 workspace 之外；
  路径沙箱保证 agent 无法读写它，防止篡改自己的轨迹。

### 5.2 工具白名单

- 安全默认集：`calculator`、`json`、`read_file`、`write_file`、`list_dir`、`glob`、`grep`。
- 默认不注册：`shell`、`http_get`、`echo`、`now`（评测中不需要）。
- `Task.permissions.tools` 显式覆盖白名单；工具注册通过 tools 插件
  `ToolPolicy.authorizer` 强制校验，不在白名单即拒绝并记录 tool/result 失败事件。
- 路径类参数复用 `packages/tools/src/path.ts` 的 `resolveInside`：拦截 `..`、
  绝对路径逃逸和 symlink 逃逸；`write_file` 只允许 workspace 内路径。
- 工具结果经 `ToolPolicy.truncator` 截断（`maxOutputBytes`，默认 256 KiB），
  防止超大输出打爆上下文。

### 5.3 Shell 与网络

- shell 默认关闭。`Task.permissions.shell.enabled` 开启后：
  - `authorizer` 校验命令首词/前缀，只放行 `allow` 白名单；
  - `deny` 黑名单优先，即使命中 `allow` 也拒绝；
  - shell 工具内部已用 `resolveInside` 锁定 `cwd` 到 workspace。
- `http_get` 默认关闭；`Task.permissions.network` 显式开启才注册。
- prompt 层同步注入约束：runner 在候选 `systemPrompt` 基础上，按 task 追加
  “评测模式下仅允许执行白名单命令，不得执行其他命令、不得访问 workspace 之外”
  的权限约束段；白名单内容来自 `task.permissions.shell.allow`。

### 5.4 资源限制

- 沿用 `TaskBudget`：`maxTurns/maxSteps/maxTimeMs/maxTokens/maxCost`。
- 新增工具级 `maxOutputBytes`（截断）与 shell/check 超时（复用现有 timeoutMs）。
- AbortController 贯通 agent loop、shell、check，超时即取消并记录 aborted。

## 6. Coding Runtime

在 `packages/eval/src/codingRuntime.ts` 内实现组合工厂，不依赖 CLI：

```ts
export interface CodingEvalRuntimeOptions {
  cwd: string
  sessionFile: string
  llm: LLMAdapter
  agentConfig: {
    systemPrompt?: string
    planPrompt?: string
    maxTurns?: number
    maxSteps?: number
  }
  codingConfig: {
    skills?: boolean
    planTools?: boolean
    mcp?: boolean
    registerAgent?: boolean
  }
  toolPolicy: ToolPolicy
  builtinToolsConfig: BuiltinToolsConfig
}

export interface CodingEvalRuntime {
  root: Context
  loop: AgentLoop
  dispose(): Promise<void>
}
```

实现要点：

- 组合顺序：session -> tools（带 ToolPolicy）-> builtinTools（带白名单配置）->
  agent -> coding-agent。
- `createCodingAgentPlugin` 增加可选 `systemPrompt` / `planPrompt` 参数，
  默认值分别是现有 `CODING_SYSTEM_PROMPT` 和 `PLAN_GENERATION_PROMPT`；
  这是本期对 coding-agent 的唯一改动。
- MCP 默认关闭，避免评测过程连接不可控的外部服务。
- runtime 的 `dispose` 按逆序释放 fiber，并确保进程内无残留会话句柄。

## 7. Trace 与 Evidence

`Evidence` 扩展：

```ts
export interface TrialTrace {
  file: string
  startedAt: number
  endedAt: number
  durationMs: number
  metrics: {
    steps: number
    turns: number
    toolCalls: number
    toolErrors: number
    invalidToolCalls: number
    retries: number
    tokens: number
    cost: number
    contextUsageRatio?: number
    recoveredAfterError: boolean
  }
}

export interface TrialEvidence {
  trial: number
  verdicts: Verdict[]
  trace: TrialTrace
  agentResult?: AgentRunResult
  artifacts: Record<string, unknown>
}

export interface Evidence {
  // ...现有字段保留
  trials?: TrialEvidence[]
}
```

要点：

- 每个 trial 的 session raw log 以 JSONL 持久化到 `runs/<runId>/traces/
  <taskId>-<trial>.jsonl`，路径写入 `TrialTrace.file`。
- trace 指标从 session raw events 派生：`tool/call`、`tool/result`、
  `llm/retry`、`turn/*`、`step/*`、`system/message` 等事件类型已存在，直接统计。
- `recoveredAfterError`：一次 `tool/result.ok=false` 或 invalid call 之后，
  后续仍出现有效步骤直至任务完成，记为恢复。
- trace 文件可供 keyless replay：LLM judge 只读 trace + task 定义，不重新运行 agent。

## 8. 评分

三层评分，全部以 strategy 形式注册到现有 `StrategyRegistry`：

1. 确定性检查（`check` strategy）：执行 `task.check`（命令或 predicate），
   结合现有 `assert`（expect / files）。命令 exit 0 为 pass，非 0 为 fail。
2. 过程指标（`trace` strategy）：对 trial trace 打分，指标包括工具选择、
   无效调用率、重试率、步骤效率、恢复率、预算内完成率。分数按权重聚合，
   权重在 strategy 配置中给定，默认全部 1。
3. LLM judge（`llm-judge` strategy）：输入为 task 定义 + trace 内容 + rubric，
   输出 0-1 分数与理由；可 keyless replay。judge 调用计入 eval 成本，
   但不计入被测 candidate 的预算。

`Task.strategies` 缺省：coding 任务默认 `["check", "trace"]`；其中 `check` strategy
在 `task.check` 缺失时回退到 `assert` 判定。原普通任务保持 `["assert"]`。

## 9. 多 Trial 聚合

- `EvalRun` 保留现有 `verdicts`/`summary` 字段做兼容，新增：

```ts
export interface TrialSummary {
  taskId: string
  trials: number
  passed: number
  passRate: number
  scoreMean: number
  scoreMedian: number
  scoreStddev: number
  costMean: number
  stepsMean: number
}

export interface EvalRun {
  // ...现有字段
  trialSummaries: TrialSummary[]
}
```

- 聚合规则：task 分数 = trials 的 passRate（check/trace 二值）或 score 均值
  （连续评分），由 strategy 输出决定；stddev 用于展示稳定性。
- `compare` 使用聚合后的 task 分数计算 delta 与回归/改进，避免单 trial 噪声。

## 10. Train / Validation 分离

- `Task.split` 标记 `train` / `val`；无标记视为 `train`。
- `EvalRun.summary` 增加按 split 的统计：`trainScore/valScore/trainPassed/
  valPassed` 等。
- evolve 只在 `train` 失败任务上反射和变异；门禁用 `val` 任务 + 共享任务回归。

## 11. 自进化

### 11.1 候选变异面

`Candidate.config` 承载完整 coding 配置 patch：

```ts
export interface CodingCandidateConfig {
  systemPrompt?: string
  planPrompt?: string
  maxTurns?: number
  maxSteps?: number
  skills?: boolean
  planTools?: boolean
  mcp?: boolean
  tools?: string[]
  shell?: EvalShellPolicy
  network?: boolean
}
```

LLM proposal 输出从“整段 system prompt”扩展为“配置 patch + rationale”，
解析器只接受白名单字段，非法字段直接拒绝该提案。
`mcp` 字段允许出现在提案 schema 中，但 eval runtime 强制为 false，防止评测连接
不可控外部服务。

### 11.2 进化循环

1. 基线：current-best candidate 在 train+val 全量任务、多 trial 下评测。
2. Diagnose：只取 train 失败任务，从 trace 提取失败模式（check 输出、无效工具
   调用、重试、预算超限、最后几步工具轨迹），写入 `Diagnosis.failureModes`。
3. Propose：LLM rule 接收诊断 + current config + 历史，生成 patch 候选；
   按 GEPA 风格只反射失败样例，跳过全对任务，避免无意义波动。
4. Evaluate：新 candidate 用相同 trials 跑全量任务，生成独立 EvalRun。
5. Gate：`minPairs + minDelta + regressions`，且 val 分数不降；通过则更新
   current-best，否则保留候选与拒绝理由。
6. 记录：experiment DAG 持久化每个节点的 candidate 快照、run id、verdict、
   delta、理由、时间戳。

### 11.3 门禁数据

`SelectionDecision.checks` 输出具体数据：

- `trainScore`：候选 train 聚合分
- `valScore`：候选 val 聚合分
- `delta`：相对 baseline 的总分差
- `regressions`：共享任务中分数下降的任务 id
- `minPairsMet`：是否达到最小任务对数
- `costDelta / stepsDelta`：记录但不强制门禁（为 Pareto 展示留数据）

## 12. 数据产物

一次 evolve 运行产出：

```text
experiments/
  log.json                    # DAG：节点、candidate 快照、run id、决策
  runs/
    <runId>.json              # EvalRun：verdicts + trialSummaries + summary
    <runId>/traces/
      <taskId>-<trial>.jsonl  # session raw trace
```

CLI `evolve run` 输出演化表：

```text
iteration candidate      train  val   delta  cost  steps  status
0         baseline       0.62   0.66  0.000  1.20  18     baseline
1         prompt-v2      0.74   0.71  +0.05  1.31  17     accepted
2         tools-tighten  0.70   0.68  -0.03  1.10  14     rejected
```

机器可读：`log.json` + EvalRun JSON 已含回归矩阵与 score-cost/score-steps
Pareto 所需数据，Web 仪表板下一期直接消费。

## 13. CLI 扩展

- `tasks.yml` 的 task 支持 `fixture/setup/check/teardown/trials/permissions/split`。
- `evolve run` 新增 `--report` 输出演化表；默认仍输出 JSON 路径。
- `eval run` 输出增加 `trialSummaries` 与 trace 目录。
- 新增 `eval replay <runId> <taskId> [trial]`：只读 trace 重放给 LLM judge，
  不重新运行 agent。

## 14. 测试数据来源

### 14.1 内置冒烟任务集（本期实现）

仓库内新增 `examples/eval/`：

```text
examples/eval/
  tasks.yml
  fixtures/
    py-math/
      math.py
      tests/test_math.py
    ts-string/
      src/string.ts
      tests/string.test.ts
```

任务都是确定性、无网络依赖的小型 coding 任务：例如“实现 `math.py` 的
`fib(n)` 并通过 `pytest`”，check 为 `pytest -q`。用于 CI、单元测试和 evolve
试跑，也作为用户编写 tasks 的模板。

### 14.2 用户项目任务集（主要来源）

用户在自己的仓库写 `tasks.yml`，`fixture.root` 指向任务模板目录，
`check` 使用真实测试命令。这符合 OpenAI Eval Skills 的方法论：
从真实使用中遇到的失败构造任务，而不是只靠合成数据。

### 14.3 失败回流（本期保留数据通路）

CLI 运行产生的 session trace 是候选数据源。本期实现 trace 持久化和
`eval replay`，使“线上失败 -> 人工转写为 task fixture + check”的通路可用；
自动转写工具不做（避免生成不可靠任务）。

### 14.4 公开 benchmark 导入（预留格式，不做适配器）

预留 JSON 导入格式（task 数组 + fixture 目录 + check 命令），
dsh-eval / SWE-bench 风格的适配器留到后续版本。

### 14.5 不做

本期不引入 LLM 合成任务生成，防止 eval 与自进化同源导致的自我确认偏差。

## 15. 向后兼容

- 现有 `Task`/`Evidence`/`EvalRun` 字段全部保留，新字段可选。
- 原普通 agent eval 走原 runner 路径，不因 coding runner 改变行为。
- `createCodingAgentPlugin` 新参数默认值不变，现有调用不受影响。
- `tasks.yml` 旧文件可继续运行。

## 16. 测试策略

1. 权限单测：白名单拒绝、路径逃逸（`..` / 绝对路径 / symlink）、shell 命令
   白名单与黑名单、truncator 截断、网络默认关闭。
2. fixture 单测：模板复制、只读语义、setup/teardown 顺序与失败清理。
3. trace 单测：从固定事件序列派生指标，覆盖重试、无效调用、恢复判定。
4. 聚合单测：passRate、均值/中位数/stddev、compare 的 delta 与回归。
5. 集成测试：fake LLM adapter + 最小 fixture 跑 coding agent（不联网），
   验证 check 判定、trace 落盘、权限拦截生效。
6. evolve 测试：确定性假 propose rule 验证 patch 应用、train/val 门禁、
   experiment DAG 记录与拒绝理由。

实施按两个可独立验收的里程碑推进：M1 eval harness（Task schema、权限、trace、
多 trial、CLI），M2 self-evolution（失败反射、train/val 门禁、实验日志）。
每个里程碑独立提交、独立测试。

## 17. 后续扩展

- Docker 容器沙箱作为可选运行时。
- Web 仪表板消费 `log.json` / EvalRun / trace。
- 公开 benchmark 导入适配器（dsh-eval 风格）。
- 失败 trace 自动转写为 eval task。
- 完整显著性检验与多目标 Pareto 自动选择。
