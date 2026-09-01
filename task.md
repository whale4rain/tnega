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
| M9 真实 LLM 工具调用端到端测试 | 已完成 |
| M10 npm / pnpm 发布准备 | 已完成 |
| M11 LLM 超时与重试 | 已完成 |
| M12 tnega web（v0，M12.7 待办） | 已完成 |
| M13 agent core 对外边界 | 已完成 |
| M14 LLM provider 抽象与 Anthropic Messages | 已完成 |
| M15 coding agent 与 web 前端架构 | 进行中 |

## 开发约定

- 每个阶段先写计划任务，再实现，再同步补测试，最后自己运行测试。
- 测试必须覆盖正常路径、失败路径、回滚路径、隔离路径。
- 每个较大阶段完成且测试通过后，git commit。
- 阶段完成后更新本文件的状态表。
- 非目标：子代理、插件市场、生产级沙箱、多模态。

## M15 coding agent 与 web 前端架构

目标：`apps/web` 同时支持 general / coding 两类 agent 会话（按会话激活），新增 `packages/coding-agent`，实现 plan & execute 模式（plan 面板展示在聊天区），为后续沙箱审批、skills、MCP 预留可插拔边界。

### M15.1 会话语义：plan 事件与 agent 元数据

- [ ] `@tnega/session` 新增 `plan` 事件：`{ id, status?, items: [{ id, title, status, detail? }], summary? }`
- [ ] `SessionLog.append` 支持 `plan`，投影时忽略（不进模型上下文），token 估算为 0
- [ ] session 元数据新增可选 `agentType`（general | coding）与 `mode`（auto | plan | execute），创建/分叉时透传
- [ ] 测试：plan append / 投影 / 估算 / 持久化；meta 字段透传

### M15.2 packages/coding-agent

- [ ] 类型：`AgentKind`、`SessionMode`、`Plan`、`PlanStatus`、`SlashCommand`
- [ ] plan 生成：用同一 LLM adapter 生成 JSON 计划（summary + items），稳健解析
- [ ] skills：扫描 workspace `.tnega/skills/<name>/SKILL.md`，提供 `skills_list` / `skill_read`
- [ ] MCP：读取 workspace `.tnega/mcp.json`，stdio 传输，工具名 `mcp__<server>__<tool>`，runtime dispose 时清理子进程
- [ ] coding agent definition：system prompt、plan 工具（plan_execute_mark / plan_execute_result）、skills、MCP
- [ ] slash command 注册表：`/plan`、`/mode` 等，供 web 查询与执行
- [ ] 测试：plan 解析、skills 加载、MCP 握手/调用/清理、插件挂载工具、slash 注册

### M15.3 CLI / web server

- [ ] `createSession` / `forkSession` 接受 agentType / mode 并持久化
- [ ] run 请求支持会话级 mode（plan 先出计划再执行），SSE 发出 `plan/*` 事件
- [ ] coding 会话路由到 coding agent runtime（默认保留 general 行为）
- [ ] `/api/coding/commands` 与 `/api/coding/slash` 端点
- [ ] 测试：coding 会话创建、plan SSE、meta 持久化、slash 端点

### M15.4 web 前端

- [ ] 会话创建与 header 显示 agentType 徽标，会话粒度切换
- [ ] chat header 提供 mode 切换（auto / plan / execute）
- [ ] plan 面板：todo 列表显示在聊天区上方，随执行实时更新
- [ ] 斜杠命令菜单：前端 `/` 选择，调用后端执行
- [ ] `plan` 会话事件渲染与流式 `plan/*` SSE 处理
- [ ] 大型 App.tsx 拆分模块，保持现有 CSS 视觉与交互习惯
- [ ] 前端类型 / API 同步更新

### M15 验收

- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全部通过
- [ ] web 可创建 coding 会话并运行 plan & execute，plan 面板与 tool 折叠正常
- [ ] 发布测试包含 `coding-agent` 子路径
- [ ] README / task.md 更新，独立功能点逐个 git commit

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

## M14 LLM provider 抽象与 Anthropic Messages

目标：能力表携带价格元数据；默认模型为 `deepseek-v4-flash`（OpenAI 兼容协议），`minimax-m3` 走 Anthropic Messages 协议；key 只从环境变量或 `.tnega` 配置读取，不进入代码。

- [x] 能力表新增价格字段：每 1M token 的 input / output / cachedRead，DeepSeek 区分 Peak / Off-Peak，附 `monthlyUsage`
- [x] `openaiCompatAdapter` 拆分为独立 provider 模块
- [x] 新增 `anthropicMessagesAdapter`，支持 Messages 请求映射、SSE 流、重试与超时
- [x] 新增 `createLlmAdapter` 按模型表选择协议，未知模型回退 OpenAI
- [x] CLI 读取系统配置 key / baseUrl / model，支持 `--config` / `--config-file`
- [x] web 服务按模型表选择协议
- [x] 测试：Anthropic 请求映射、SSE、重试、key 不泄露；provider 路由；CLI 配置读取
- [x] README 与 task.md 更新
- [x] git commit

验收：`pnpm typecheck`、`pnpm lint`、`pnpm test` 全部通过；`tnega run` 默认请求 `.../v1/chat/completions` 且使用 `deepseek-v4-flash`。

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

## M9 真实 LLM 工具调用端到端测试

目标：补上“真实 LLM 实际调用默认工具”的端到端验证，并让 mock 测试确定性覆盖同一管线，避免工具集只注册不执行。

- [x] mock 端到端：`packages/cli/test/tools-e2e.test.ts` 4 个测试
- [x] mock 覆盖：`calculator` 执行并写入 session、`read_file` 路径沙箱拒绝 `../`、`shell` 仅 `allowShell` 时执行、`http_get` 仅 `allowNetwork` 时执行
- [x] 真实 LLM 冒烟：`test/deepseek-tools.smoke.test.ts` 3 个测试
- [x] 真实覆盖：`calculator` / `read_file` / `shell` 均由真实 DeepSeek 调用，session 含 tool-call 与 tool-result 且不含 key
- [x] 测试记录：`docs/test/tools-llm-e2e.md`
- [x] 全量 typecheck / test / lint 通过
- [x] 更新 README / task.md
- [x] git commit（M9）

## M10 npm / pnpm 发布准备

目标：让 `tnega` 可以通过 npm 与 pnpm 安装。采用单包路线：根包作为公共自包含 CLI 发布，内部 `@tnega/*` workspace 包保持 private，后续需要库级发布再拆。

- [x] 根包发布元数据：name `tnega` / version `0.1.0` / public / MIT / `files: ["dist"]` / `engines.node >= 22`
- [x] CLI bin 源码入口：`packages/cli/src/bin.ts`，`bin.tnega` 指向 `dist/bin.js`
- [x] esbuild 自包含构建：`scripts/build.mjs` 产出 `dist/bin.js` 与 `dist/index.js`，不残留 `@tnega/` 外部 import
- [x] `prepublishOnly`：自动执行 `pnpm test:package`（build + 发布测试）
- [x] 测试：`test/publish.test.ts` 覆盖发布元数据、bin 源码、bundle 自包含性与 CLI 冒烟
- [x] 本地安装验证：`npm install` 与 `pnpm add` tarball 后 `node node_modules/tnega/dist/bin.js` 可运行
- [x] 测试记录：`docs/test/npm-publish.md`
- [x] 全量 typecheck / test / lint 通过
- [x] git commit（M10）

## M11 LLM 超时与重试

目标：为真实 LLM 请求增加超时、退避重试与可配置 CLI 参数，避免长请求或上游瞬时 5xx 直接失败。

- [x] `openaiCompatAdapter` 新增 `timeoutMs / maxRetries / retryDelayMs` 配置
- [x] 默认 120s 超时、最多 2 次重试、500ms 指数退避
- [x] 仅对网络错误、408 / 425 / 429 / 5xx 重试；401 / 403 等 4xx 不重试
- [x] 外部 abort 立即停止且不重试；超时后仍按重试策略重试
- [x] `tnega run` 与 `tnega evolve run` 新增 `--timeout-ms / --max-retries / --retry-delay-ms`
- [x] 测试：500 / 429 / 网络错误 / 超时重试成功、重试耗尽、401 不重试、调用方取消、`maxRetries: 0`、CLI 参数透传
- [x] 全量 typecheck / test / lint 通过
- [x] git commit（M11）

## M12 tnega web

目标：为 tnega 实现类似 dsh 的本地 Web UI。v0 提供聊天 / 多轮会话 / 工具时间线 / 工作区 / 工具权限 / 设置；v1 提供 eval 与 evolve 的只读仪表板。

### M12.1 文档与设计登记

- [x] CONTEXT.md 术语表
- [x] ADR：系统级 API 配置、Agent 流式 SSE、React + Vite 前端
- [x] README / task.md 登记 M12，移除 Web UI 非目标

### M12.2 LLM 流式适配

- [x] `LLMAdapter.stream()` 与 SSE 解析，归一化 `message_start / message_delta / message_stop / toolcall_start / toolcall_end`
- [x] 流式测试：内容增量、工具参数累积、finish reason、超时与 abort

### M12.3 Agent 流式运行

- [x] `AgentService.runStream()` 异步生成器，`run()` 收集结果
- [x] 取消语义：LLM 立即中止，工具等返回后停止，run 标 cancelled
- [x] 共享 Agent 运行时工厂，CLI 与 Web 复用

### M12.4 配置与会话存储

- [x] 系统级配置：Windows `%APPDATA%\tnega\config.json`，macOS/Linux `~/.config/tnega/config.json`，env 优先
- [x] 每工作区 `.tnega/sessions/<id>.jsonl`，meta 存标题 / workspace / createdAt
- [x] 自动标题、重命名、fork、删除（仅空闲）

### M12.5 HTTP / SSE 服务端

- [x] 原生 `node:http` 极简 router，零运行时依赖
- [x] `POST /api/sessions/:id/runs` 返回 SSE；断连即取消；同 session 仅一个 active run
- [x] 跨站防护：JSON content-type + `x-tnega-client: 1`
- [x] 协议单测 + mock LLM API 集成测试

### M12.6 React / Vite 前端

- [x] `apps/web` React + Vite + TypeScript，浅色 manpage 风（严格按 DESIGN.md）
- [x] 侧栏最近工作区 + 添加路径；会话列表；多轮聊天；fork；工具权限开关
- [x] 设置页：apiKey、model 下拉、baseUrl、temperature，env > config > 默认
- [x] 生产 dist 打进 npm，`tnega web` 托管静态资源与 API
- [x] 全量 typecheck / test / lint / build 通过
- [x] git commit（M12）

### M12.7 eval / evolve 只读仪表板

- [ ] 只读展示 `.tnega/runs/*.json` 与实验树，浏览器不触发 eval/evolve
- [ ] 测试与文档记录
- [ ] git commit（M12.7）

## M13 agent core 对外边界

目标：让 `tnega` 可以作为库被外部 agent（如后续独立仓库的 coding agent）复用，补齐可编程契约、声明式 agent 定义、可插拔会话投影与工具策略，并验证发布包在消费者侧的类型与运行时可用性。

验收：根包 `import { Context, defineAgent, SessionLog } from 'tnega'` 可用；新增契约全部配套测试；typecheck / lint / test / build 全绿；README 记录库用法与边界。

- [x] M13.1 根包库入口：`src/index.ts` 汇聚 core / agent / tools / session / eval / evolve / llm / cli 公开 API，`exports` 指向 `dist/index.js` 与 `dist/types`，构建生成并重写声明，publish 测试覆盖消费者导入
- [x] M13.2 AgentDefinition：`name / version / system / tools / loop / hooks` 的声明式插件契约，system 注入 agent loop，卸载无残留
- [x] M13.3 SessionProjector 与 context budget：可插拔投影器 + token 估算 / 预算工具，从 cli store 下沉到 session
- [x] M13.4 Tools policy：输入校验、授权、输出截断三类可插拔策略 + 轻量 schema 校验器
- [x] M13.5 README 库用法、契约文档与状态更新
- [x] M13.6 runtime 组合边界：`createAgentRuntime` 可注入 `AgentDefinition` / `SessionProjector` / `ToolPolicy` / `builtinTools: false` / `plugins`，`llm` 可选；默认 loop 执行 `beforeRun` / `afterRun`；新增 agent + cli 组合测试
- [x] M13.7 context budget 与子路径导出：`AgentConfig` / `AgentRunOptions` 支持 `contextBudget`，默认 loop 每 step 按 token 估算压缩并派发 `agent/context-compact`；`session.compact` 新增 `messages` 选项使 checkpoint 保存压缩后状态，replay / derive 与 loop 续跑一致；`createAgentRuntime` 支持注入自定义 `inbox`；发布包新增 `tnega/agent`、`tnega/cli/runtime`、`tnega/core`、`tnega/eval`、`tnega/events`、`tnega/evolve`、`tnega/llm`、`tnega/services`、`tnega/session`、`tnega/tools` 子路径导出；测试覆盖压缩事件、自定义 summarizer、非法配置、inbox 注入与消费者子路径导入
- [x] 全量测试 / typecheck / lint / build 通过，更新状态与提交记录

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
- M9：`b456dd5` 真实 LLM 工具调用端到端测试（mock e2e 4 tests / real smoke 3 tests / 测试记录）
- M10：`d1a3869` npm / pnpm 发布准备（esbuild 自包含 CLI / publish tests / 测试记录）
- M11：`d1cf092` LLM 超时与退避重试（README / task.md 同步更新）
- M12.1：`c732dc0` Web UI 文档与 ADR 登记
- M12.2：`23cb122` LLM SSE 流式适配
- M12.3：`4eb7b2c` Agent 流式 / 可取消运行，`c6c6d14` 取消语义确定性修复
- M12.4-5：`b180f8c` 系统配置 / 会话存储 / HTTP + SSE 服务端
- M12.6：`660ed9d` React + Vite 前端与 `tnega web` 构建集成
- M12.7：待办（eval / evolve 只读仪表板未提交）
- M13.1：`f990674` 根包库入口（`tnega` library entry + packed types）
- M13.2：`1e02c0d` AgentDefinition 声明式契约
- M13.3：`1b0a201` SessionProjector 与 context budget
- M13.4：`d21b630` Tools policy（validator / authorizer / truncator）
- M13.5：`a054cc7` README 库用法与 M13 状态更新
- M13.6：`8c73d13` 默认 loop hooks 生效；`c56ea1c` createAgentRuntime 外部组合入口
- M13.7：`26f1475` 默认 loop context budget / compact checkpoint 消息状态 / runtime inbox 注入 / 子路径导出
- M14.1：`6f963d1` README 英文重构 + 中文文档；默认模型改为 `deepseek-v4-flash`，版本升至 0.1.1
