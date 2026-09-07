# `@tnega/eval`

Eval 作为一等公民：与 Agent Loop、Tools 平级。任务、策略、证据、判定、运行都是
可插拔原语；eval 同时是自进化的适应度函数。

## 核心对象

- `Task`：一条可运行任务（prompt/断言/预算）
- `EvalStrategy`：如何判分 —— `assert`（结果匹配/文件断言）、`llm-judge`、
  `regression`（对比 baseline）、组合 gate（`all`/`weighted`/`safety` 必过）
- `Evidence` / `Verdict` / `EvalRun`：单任务证据、判定、整场运行（持久化 JSON）

## 运行器

- `ctx.eval`：`register / run / get / compare`
- 每个 run 创建隔离子 Context + Fiber；candidate 在隔离 scope 加载，结束自动卸载。
- 预算控制：回合 / token / 成本 / 时间上限。
- 缓存：task + candidate 版本 + 模型配置哈希，命中即跳过。
- 真实 benchmark 评测编排在 `packages/benchmark` + CLI `eval run`。

## 事件

`eval/start`、`eval/task-start`、`eval/task-end`、`eval/verdict`、`eval/run-end`、
`eval/abort`。

## 与 coding runner 的关系

`eval` 同时提供面向真实工作区 agent 的 runner（`codingRunner` / `codingRuntime` /
`workspace` / `trace`）—— 让评测跑在一个真实 coding-agent 会话里并采集完整 trace，
供失败回流与自进化使用。

## 测试

`packages/eval/test/`：run 生命周期、隔离卸载、预算中止、缓存命中、错误证据仍可判分、
策略注册/组合/gate。真实 LLM 评测结果见 `docs/eval-results.md`。
