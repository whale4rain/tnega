# Tnega 开发计划与进度追踪

> 每完成一个较大阶段及任务，需要完整的、全面的测试文件同步生成，并自己测试。

开发必须按本文件推进。每个阶段完成标准：功能实现、测试文件同步生成并全部通过、进度状态更新、达到提交点则 git commit。

## 项目目标

自研核心语义的 Agent Harness，参照 DeepSeek Harness 的时空可组合思想，Eval 与 Agent Loop、Tools 平级，最终支持 Agent 自进化实验。

## 当前状态

| 阶段 | 状态 |
| --- | --- |
| M0 项目初始化 | 已完成 |
| M1 core 时空语义 | 已完成 |
| M2 agent + tools + session | 已完成 |
| M3 eval 评测运行时 | 已完成 |
| M4 evolve 进化循环 | 已完成 |
| M5 真实 LLM 接入 | 已完成 |
| M6 时空可组合极端压力测试 | 已完成 |
| M7 真实 LLM 自进化闭环 | 已完成 |
| M8 最小内置工具集 | 已完成 |

## 开发约定

- 每个阶段先写计划任务，再实现，再同步补测试，最后自己运行测试。
- 测试必须覆盖正常路径、失败路径、回滚路径、隔离路径。
- 每个较大阶段完成且测试通过后，git commit。
- 阶段完成后更新本文件的状态表。
- 非目标：Web UI、子代理、插件市场、生产级沙箱、多模态。

## M0 项目初始化

目标：建立可运行、可测试的工程骨架。

- [x] README.md 编写
- [x] pnpm workspace 初始化（packages 结构）
- [x] 根 package.json 与脚本（build / test / lint）
- [x] TypeScript 严格模式配置
- [x] Vitest 测试环境与 smoke test
- [x] 目录结构落地：core / agent / tools / session / eval / evolve / cli
- [x] 测试：smoke test 验证 build 与 test 链路可用
- [x] 更新 task.md 状态
- [x] git commit（M0）

验收：`pnpm test` 可用，workspace 可解析，CI 链路在本地可跑通。

## M1 core 时空语义

目标：自研 Context / Fiber / Effect / Event / Registry / Reflect，实现插件热插拔、失败回滚、依赖联动、scope 隔离。

### M1.1 基础工具

- [x] DisposableList：push / delete / clear，clear 返回逆序列表
- [x] 最小 Logger
- [x] 错误组合与异步堆栈辅助
- [x] 测试：DisposableList 顺序、删除、重复清理

### M1.2 事件系统

- [x] EventsService：emit / parallel / serial / bail / waterfall
- [x] 监听器注册与注销，卸载时自动清理
- [x] scope 可见性过滤与 global 选项
- [x] 测试：四种派发模式、异常传播、卸载清理、scope 过滤

### M1.3 Fiber 生命周期

- [x] Fiber 状态机：pending / loading / active / failed / unloading / disposed
- [x] effect 收集：同步 / 异步 dispose 函数
- [x] 卸载时逆序执行 disposables，等待异步清理
- [x] 加载中途抛错时回滚已注册 effects
- [x] epoch 与配置变化触发 reload
- [x] inertia 串行化并发刷新
- [x] 根 Fiber 与 restart
- [x] 测试：热插拔、热重载、失败回滚、异步清理、并发刷新、reload 后旧注册不残留

### M1.4 Context 与 Scope

- [x] Context 树：extend 创建子 Context，服务沿父链查找
- [x] isolate / intercept 语义
- [x] 测试：子 Context 隔离、服务覆盖、父级不受污染

### M1.5 Registry 与 Reflect

- [x] RegistryService：plugin 挂载、插件身份去重、fibers 管理
- [x] ReflectService：provide / inject、服务访问、Impl 语义
- [x] internal/service 与 internal/get/set 钩子
- [x] 测试：依赖齐备才激活、依赖消失依赖方先停、provider 恢复后自动重载、循环依赖报错

### M1 验收

- [x] 所有 core 测试通过
- [x] 编写一个演示测试：插件注册工具与监听器，热卸载后全部清除
- [x] 更新 task.md 状态
- [x] git commit（M1）

## M2 agent + tools + session

目标：最小可运行的 Agent 循环，JSONL 会话日志，工具注册与执行管线。

### M2.1 session

- [x] SessionEvent 事件类型定义
- [x] JSONL append-only 会话日志
- [x] deriveMessages 从日志投影模型历史
- [x] replay / fork / compact
- [x] 测试：日志追加、投影、replay 一致性、fork 隔离、compact 后仍可重建历史

### M2.2 tools

- [x] 工具注册表，schema 与执行函数
- [x] 执行管线：pre-execute / execute / post-execute / result
- [x] 工具按 scope 注册，per-agent 能力集
- [x] 测试：注册卸载、管线钩子顺序、scope 隔离、工具异常处理

### M2.3 agent

- [x] Agent 接口与 agentLoop 可替换 service
- [x] turn / step 生命周期与 agent/* 事件
- [x] 最小 inbox：输入 claim 与 injected context
- [x] LLM 适配器 seam，供测试注入 fake LLM
- [x] 测试：单步循环、多步工具循环、turn 结束条件、事件顺序、fake LLM 端到端

### M2 验收

- [x] 用 fake LLM 跑通一次包含工具调用的完整会话
- [x] session 日志可重建模型输入
- [x] 更新 task.md 状态
- [x] git commit（M2）

## M3 eval 评测运行时

目标：Eval 成为与 Agent Loop、Tools 平级的一等公民，提供可插拔策略与隔离实验。

### M3.1 核心对象

- [x] EvalStrategy / Task / Evidence / Verdict / EvalRun 类型
- [x] ctx.eval：register / run / get / compare
- [x] eval/* 事件：start / task-start / task-end / verdict / run-end / abort

### M3.2 运行器

- [x] run 创建隔离子 Context 与 Fiber
- [x] candidate 在隔离 scope 加载，结束自动卸载
- [x] 每个 task 独立子 Context，调用 agentLoop 并收集 evidence
- [x] 预算控制：回合 / Token / 成本 / 时间上限
- [x] 缓存：task + candidate 版本 + 模型配置哈希
- [x] 测试：run 生命周期、隔离卸载、预算中止、缓存命中、错误证据仍可判分

### M3.3 策略

- [x] assert 策略（结果匹配 / 文件断言）
- [x] llm-judge 策略（确定性评分，可 keyless replay）
- [x] regression 策略（对比 baseline，允许退化阈值）
- [x] 组合与 gate：all / weighted / safety 必过
- [x] 测试：策略注册卸载、组合判分、gate 通过拒绝、regression 退化拦截、LLM judge 稳定性

### M3.4 CLI 与持久化

- [x] tnega eval run tasks.yml
- [x] tnega eval compare <a> <b>
- [x] EvalRun 持久化与读取
- [x] 测试：CLI 端到端、结果文件可回读

### M3 验收

- [x] 候选 preset 在隔离环境评测后无残留
- [x] 同一 evidence 重放结果稳定
- [x] 更新 task.md 状态
- [x] git commit（M3）

## M4 evolve 进化循环

目标：用 core 的安全变异 + eval 的可靠评估，实现候选生成、比较、选择与持久化。

### M4.1 候选与实验

- [x] Candidate：preset / plugin / mutation / rationale
- [x] propose 接口：诊断失败模式并生成候选
- [x] ExperimentLog 树：candidate + verdicts + parent baseline
- [x] 测试：候选生成、实验树持久化、fork / 回放

### M4.2 选择策略

- [x] compare：baseline vs candidate 配对比较
- [x] gate 策略：safety 必过、regression 阈值、显著性规则
- [x] 接受后持久化为新 baseline，拒绝后保留旧 baseline
- [x] 人工审批 seam（eval/run-end 事件可暂停）
- [x] 测试：接受 / 拒绝路径、退化拦截、budget 中止、审批暂停与恢复

### M4.3 闭环演示

- [x] 一个确定性 demo：规则 propose + fake eval 完成多轮进化
- [x] 验证：候选失败不影响主 runtime
- [x] 更新 task.md 状态
- [x] git commit（M4）

## M5 真实 LLM 接入

目标：用可插拔的 OpenAI 兼容 LLM 适配器接通真实 DeepSeek，并让 CLI 直接运行一次 agent 会话；API key 只从环境变量读取，绝不进入代码或仓库文件。

### M5.1 LLM 适配器

- [x] `@tnega/llm` 包：OpenAI compatible `chat/completions`
- [x] `openaiCompatAdapter(config)` 返回 `LLMAdapter`
- [x] 消息 / tool calls / finish reason / JSON arguments 映射
- [x] 非 2xx、非法 JSON、网络失败统一包装为 `OpenAICompatibleError`
- [x] `listModels(config)` 查询模型列表
- [x] 测试：请求构造、tool calls、abort、异常、默认配置、模型列表

### M5.2 CLI run

- [x] `tnega run "prompt"`，支持 `--cwd / --session / --model / --base-url / --max-tokens / --temperature / --max-turns / --max-steps`
- [x] key 从 `OPENCODE_GO_API_KEY` 读取，兼容 `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`
- [x] 会话写入 `.tnega/run.jsonl`，文件中不含 key
- [x] 测试：mock OpenAI 端到端、缺 key 报错、输出与 session 持久化

### M5 验收

- [x] 单元测试 + CLI 测试全部通过
- [x] 用真实 OpenCode Go key 完成一次 DeepSeek 冒烟
- [x] 更新 README / task.md / .gitignore
- [x] git commit（M5）

## M6 时空可组合极端压力测试

目标：对 M1 的时空可组合语义做真实压力验证，覆盖热插拔风暴、依赖级联、scope 风暴、并发卸载与失败回滚的极端路径。

- [x] 时间可组合：100 次热插拔无监听器 / service / disposer 残留
- [x] 依赖替换：20 代 provider 热替换，dependent 每代恰好 reload 一次
- [x] 依赖级联：128 插件链整体失活、整体重新激活
- [x] 空间可组合：64 个 sibling scope 同名 service 互不污染
- [x] 并发：64 个同插件 fiber 同时挂载 / 卸载
- [x] 健康检查抖动：65 次 notify 拨动，最终无监听残留
- [x] 热更新：100 次 update 风暴合并为最终 config
- [x] 嵌套生命周期：父插件卸载先清理父 disposer，再等待子插件完全卸载
- [x] 失败路径：disposer 抛错时其余 disposer 继续执行，fiber 仍到达 disposed
- [x] 全量 typecheck / test / lint 通过
- [x] 测试记录：`docs/test/spacetime-composability.md`
- [x] git commit（M6）

## M7 真实 LLM 自进化闭环

目标：把自进化闭环接上真实 LLM，Agent Loop 和候选提案都由真实 DeepSeek 驱动，跑通 baseline 评测 → LLM 提案 → 候选评测 → gate 选择 → 持久化。

- [x] evolve 新增 `llmCandidate` 与 `createLlmProposeRule`，提案要求返回 JSON 并校验字段
- [x] CLI 新增 `tnega evolve run tasks.yml`，支持 `--iterations / --max-turns / --max-steps / --max-tokens / --model / --base-url / --no-cache`
- [x] 测试：提案解析、system prompt 注入、llmCandidate 隔离评测、CLI mock 端到端、key 不落盘
- [x] 真实 DeepSeek 端到端实验：baseline + 提案 + 候选评测 + gate 拒绝 + 实验树持久化
- [x] 测试记录：`docs/test/evolve-llm-e2e.md`
- [x] 全量 typecheck / test / lint 通过
- [x] git commit（M7）

## M8 最小内置工具集

目标：参照常见 agent 的最小工具集合，为 `tnega run` 提供开箱即用的基础能力，同时保持工具即插件的时空可组合语义，并为高权限能力设置显式开关。

- [x] `calculator`：安全算术表达式解析器，支持 `+ - * / % ^`、括号、`pi/e/tau` 与常用函数，拒绝除法/对数/开方中的非法输入
- [x] `path` 沙箱：`resolveInside` 将路径限制在 cwd 内，拒绝绝对越界、`..` 越界与 symlink 越界
- [x] `builtinTools` 插件：默认注册 `echo / now / calculator / json / read_file / write_file / list_dir / glob / grep`，卸载自动注销
- [x] `http_get` 与 `shell` 默认不注册，CLI 通过 `--allow-network` / `--allow-shell` 显式开启
- [x] 文件工具：拒绝二进制文件，写入/读取字节上限、搜索字节与结果上限、shell 超时上限
- [x] `BuiltinToolsConfig`：`cwd / allowNetwork / allowShell / disabled / maxReadBytes / maxWriteBytes / maxSearchBytes / maxResults / timeoutMs`
- [x] 测试：注册与卸载、disabled、scope 隔离、calculator / json、文件读写与搜索、路径逃逸、二进制与字节限制、网络与 shell 开关，共 16 个测试
- [x] 全量 typecheck / test / lint 通过
- [x] 更新 README / task.md
- [x] git commit（M8）

## 提交记录

按阶段记录 commit，后续在此追加。

- M0：`867e53b` 项目初始化（workspace / TypeScript / Vitest / ESLint / smoke test）
- M1：`007f2bb` core 时空语义（Context / Fiber / Effect / Event / Registry / Reflect + 85 tests）
- M2：`9e4b78f` agent + tools + session（SessionLog / ToolsService / AgentLoop + 45 tests）
- M3：`68631c7` eval 评测运行时与 CLI（EvalRunner / strategies / eval run + compare + 29 tests）
- M4：`31ea62e` evolve 进化循环（Candidate / propose / ExperimentLog / selection gate + 11 tests）
- M5：`d74dcc9` 真实 LLM 接入（OpenAI compatible adapter / tnega run / real DeepSeek smoke）
- M6：`a8cd087` 时空可组合极端压力测试（10 extreme spacetime tests，测试记录 `1db8eb4`）
- M7：`19d831c` 真实 LLM 自进化闭环（evolve run / LLM propose / real DeepSeek e2e）
- M7 测试记录：`b6d2917` 真实 LLM e2e 文档（README / task.md 同步更新）
- M8：`85baa91` 最小内置工具集（builtinTools 插件 / path 沙箱 / calc / CLI 权限开关 + 16 tests）
