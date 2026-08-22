# Tnega

Tnega 是 "agent" 的逆写，也是本项目想做的事：把 Agent 本身当作可以被观察、修改、回滚和进化的对象。

Tnega 是一个自研核心的 Agent Harness，参照 DeepSeek Harness 的时空可组合思想，同时把简洁性作为硬约束，并把 Eval 提升为与 Agent Loop、Tools 平级的一等公民。

## 为什么做 Tnega

- Agent = Model + Harness。模型负责思考，Harness 负责模型之外的一切：记忆、工具、权限、执行、评估。
- 大多数 Harness 是固定系统。Tnega 的目标是让 Harness 本身可以被安全地热插拔和回滚，从而为 Agent 自进化提供基础。
- dsh 证明了 "一切皆插件" 可以做到，但整个工程很大。Tnega 自研一个语义完整、体积可控的核心，再叠加薄业务层。

## 核心语义

- Context：运行环境与作用域树。服务查找沿父链向上，子 Context 可覆盖服务，隔离通过 scope 实现。
- Fiber：插件实例的生命周期。状态为 pending / loading / active / failed / unloading / disposed。
- Effect：每次修改都携带撤销函数，卸载时逆序执行，保证无残留。
- Event：emit / serial / bail / waterfall 四种派发模式，所有扩展点都是事件。

时空可组合：

- 时间可组合：组件可以热插入、热拔出、热替换，失败可回滚。
- 空间可组合：依赖齐备才激活，provider 消失时依赖方先停；不同 scope 拥有不同组合。

## 模块规划

| 包 | 职责 |
| --- | --- |
| core | Context / Fiber / Effect / Event / Registry / Reflect |
| agent | 最小 Agent Loop，作为可替换 service |
| tools | 工具注册与执行管线 |
| session | JSONL 事件日志，支持 replay / fork / compact |
| eval | 评测运行时：策略注册、任务执行、证据收集、判分、持久化 |
| evolve | 进化循环：生成候选、评估、比较、接受或拒绝 |
| cli | headless 命令行入口 |

## Eval 是一等公民

Eval 不是测试工具，而是 runtime 的裁判，也是进化的 fitness function。它与 Agent Loop、Tools 平级，共享同一套 Fiber / Effect / Event 机制。

核心对象：

- EvalStrategy：评测策略，以插件形式注册和卸载。
- Task：任务定义，包含输入、setup、超时与预算。
- Evidence：不可变证据，由 session log 与 artifacts 组成，可 keyless replay。
- Verdict：单个策略对单个任务给出的判分结果。
- EvalRun：一次完整评测，包含候选组件、baseline、verdicts 与 summary。

原则：

- Evidence 是不可变证据：session log + artifacts，重放不需要重新调用模型。
- Strategy 是插件：可注册、可卸载、可热替换。
- Run 是隔离实验：候选组件在独立 scope 中加载，跑完自动卸载。
- Gate 是确定性的：接受或拒绝由阈值、regression、safety 规则决定，而非模型自我评价。

## 自进化

Tnega 把自进化拆成三个可独立验证的阶段：

1. 安全变异：core 的时空语义保证组件可以安全地插入、替换、回滚。
2. 可靠评估：eval 对候选组件运行同一套任务与策略，产生可比较的分数。
3. 选择与持久化：通过 gate 的候选成为新 baseline，失败的进入 experiment log。

Experiment log 是一棵树，每个节点包含 candidate、verdicts 与 parent baseline，可回放、可 fork。

## 与 dsh 的关系

- 理念参照 DeepSeek Harness 与 Cordis 的时空可组合。
- 核心语义自研，代码自维护，不依赖 Cordis 运行时。
- 暂时不做：Web UI、子代理、插件市场、生产级沙箱、多模态。

## 路线图

- M1：core 时空语义，插件热重载与回滚。
- M2：agent loop + tools + session。
- M3：eval runner 与策略（assert / llm-judge / regression）。
- M4：evolve 进化循环与 experiment log。

## 目录结构（规划）

```text
packages/
  core/       # Context, Fiber, Effect, Event, Registry, Reflect
  agent/      # Agent Loop
  tools/      # Tool Registry & Execution
  session/    # JSONL Session Log
  eval/       # Eval Runtime
  evolve/     # Evolution Loop
  cli/        # Headless CLI
```

## 使用（规划）

```text
tnega run                 # 运行一次 agent 会话
tnega eval run tasks.yml  # 运行评测
tnega eval compare a b    # 比较两次评测
tnega evolve --budget 10  # 运行进化循环
```

## 状态

- M1 core 时空语义：已完成。Context / Fiber / Effect / Event / Registry / Reflect 已落地，支持插件热插拔、失败回滚、依赖联动与 scope 隔离，配套 85 个 core 测试。
- M2 agent + tools + session：未开始。
- M3 eval 评测运行时：未开始。
- M4 evolve 进化循环：未开始。
