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
| llm | OpenAI 兼容 LLM 适配器，默认对接 OpenCode Go DeepSeek |
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

evolve 是进化循环本身：`propose` 根据当前 baseline 的诊断结果生成候选，`evaluate` 在 eval 的隔离 scope 中运行候选，`decide` 用可插拔的 gate 比较 baseline 与 candidate，接受后持久化为新 baseline，拒绝后保留旧 baseline。人工审批通过 `evolve/approval-request` 事件暂停，调用方可以异步 approve / reject。

## 与 dsh 的关系

- 理念参照 DeepSeek Harness 与 Cordis 的时空可组合。
- 核心语义自研，代码自维护，不依赖 Cordis 运行时。
- 暂时不做：子代理、插件市场、生产级沙箱、多模态。

## 路线图

- M1：core 时空语义，插件热重载与回滚。
- M2：agent loop + tools + session。
- M3：eval runner 与策略（assert / llm-judge / regression）。
- M4：evolve 进化循环与 experiment log。
- M5：真实 LLM 接入与 `tnega run`。
- M6：时空可组合极端压力测试。
- M7：真实 LLM 自进化闭环。
- M8：最小内置工具集与路径沙箱。
- M9：真实 LLM 工具调用端到端测试。
- M10：npm / pnpm 发布准备，`tnega` 作为自包含 CLI 包可安装。
- M11：LLM 请求超时与退避重试。
- M12：`tnega web` 本地 Web UI（会话、流式聊天、工作区、工具权限、设置、eval/evolve 只读仪表板）。

## 目录结构（规划）

```text
packages/
  core/       # Context, Fiber, Effect, Event, Registry, Reflect
  agent/      # Agent Loop
  tools/      # Tool Registry & Execution
  session/    # JSONL Session Log
  eval/       # Eval Runtime
  evolve/     # Evolution Loop
  llm/        # OpenAI-compatible LLM Adapter
  cli/        # Headless CLI
```

## 作为库使用

`tnega` 从 0.1.0 起同时发布为库入口。外部 agent（包括独立仓库的 coding agent）可以直接依赖根包，用 `Context` 组装自己的运行时，不需要依赖内部 `@tnega/*` 包。发布包通过 `exports` 暴露 `dist/index.js` 与 `dist/types`，所有公共契约都有类型声明。

```ts
import {
  Context,
  session,
  tools,
  builtinTools,
  defineAgent,
  openaiCompatAdapter,
  type AgentLoop,
} from 'tnega'

const root = new Context()
const sessionFiber = await root.plugin(session, {
  file: '.tnega/coding-agent.jsonl',
})
const toolsFiber = await root.plugin(tools)
const builtinFiber = await root.plugin(builtinTools, {
  cwd: process.cwd(),
})

const agentFiber = await root.plugin(
  defineAgent({
    name: 'coding-agent',
    version: '0.1.0',
    system: 'You are a coding agent.',
    tools: [], // 专属工具随插件生命周期注册与注销
  }),
  { llm: openaiCompatAdapter({ apiKey: process.env.OPENCODE_GO_API_KEY! }) },
)

const loop = root.get('agentLoop') as AgentLoop
const result = await loop({ text: 'implement the feature' })
console.log(result.output)

for (const fiber of [agentFiber, builtinFiber, toolsFiber, sessionFiber].reverse()) {
  await fiber.dispose()
}
```

M13 为外部 agent 补齐的三个主要契约：

- `AgentDefinition`：`defineAgent({ name, version?, system?, tools?, loop?, hooks? })` 返回普通插件。默认 loop 使用 `config.llm` 并注入 `agentSystem`，同时执行 `beforeRun` / `afterRun` hooks；传入自定义 `loop` 时，tnega 同样负责 system 注入与 hooks 包装；`tools` 随插件挂载和卸载自动注册、注销，并派发 `agent/definition` 元数据事件。
- `SessionProjector` 与 context budget：`session` 插件可通过 `projector` 配置自定义 JSONL 事件到模型消息的投影；`SessionLog.deriveMessages()`、`estimateContext()` 与 `compact({ keepTokens })` 共用同一投影器。估算与预算工具也独立导出：`estimateContextUsage`、`estimateMessageTokens`、`estimateEventTokens`、`suffixStartIndexForTokens`、`resolveCompactKeep`、`DEFAULT_CONTEXT_LIMIT`。

默认 loop 现在内置 context budget：`AgentConfig` 或 `AgentRunOptions` 传入 `contextBudget: { limit, compactRatio, keepTokens, summarize }` 后，每个 step 前会按 token 估算检查用量，超过 `compactRatio` 时先调用 `summarize`（缺省生成内置摘要），再执行 `session.compact` 保留最近 `keepTokens`，并派发 `agent/context-compact` 事件；压缩后的消息状态写入 checkpoint，因此后续 step 与 session replay / derive 看到的上下文一致。`compact` 新增可选 `messages` 字段，用于把显式压缩结果作为 checkpoint 消息状态，默认仍保留压缩前投影，不改变原有 `compact` 语义。
- `ToolPolicy`：`validator`、`authorizer`、`truncator` 可配置在 `tools` 全局层，也可覆盖在单个 `ToolDefinition.policy`。执行顺序为 `pre-execute → authorizer → validator → execute → truncator → post-execute / result`；策略拒绝会返回 `ToolResult.ok === false` 而不是把异常抛给 agent loop。`validateSchema` 支持 required、type、enum、嵌套对象与数组，并允许不带 `type` 的属性（视为任意 JSON）。

另外 `createAgentRuntime` 现在支持直接注入 `agent`（`AgentDefinition` 或裸 agent 对象）、自定义 `inbox`、`sessionProjector`、`toolPolicy`、`contextBudget`、`builtinTools: false` 与 `plugins`，`llm` 也可由外部 provider 通过 `agentLoop` 提供；`LLMAdapter`、eval / evolve 服务同样通过根包导出。外部 agent 既可以只替换 loop 和工具，也可以组合整个 runtime 生命周期，并直接嵌入评测与进化闭环。

除根入口外，发布包还提供按域拆分的子路径导出，外部 agent 可以只引入需要的部分：

```text
tnega/agent         # AgentLoop / AgentDefinition / AgentService / inbox / context budget
tnega/core          # Context / Fiber / Effect / Event / Registry / Reflect
tnega/session       # SessionLog / projector / compact / token 估算
tnega/tools         # ToolsService / ToolDefinition / ToolPolicy
tnega/eval          # EvalStrategy / Task / Verdict / EvalRun
tnega/evolve        # Candidate / ExperimentLog / propose / gate
tnega/llm           # openaiCompatAdapter 与重试配置
tnega/cli/runtime   # createAgentRuntime 组合运行时
tnega/events        # EventsService / DispatchMode / Hook
tnega/services      # service / registry / reflect / logger
```

每个子路径都有对应的运行时 bundle 与类型声明，`test/publish.test.ts` 会以消费者身份逐一验证。

## 使用

发布后可通过 npm 或 pnpm 全局安装：

```text
npm install -g tnega
pnpm add -g tnega
tnega run "prompt"
```

本地开发仍使用 workspace 脚本：

```text
pnpm tnega run "prompt"            # 运行一次 agent 会话（读取环境变量 key）
pnpm tnega run --allow-network "fetch https://example.com"
pnpm tnega run --allow-shell "list files and summarize"
pnpm tnega web                         # 启动本地 Web UI（默认 http://127.0.0.1:3080）
pnpm tnega eval run tasks.yml      # 运行评测
pnpm tnega eval compare a b        # 比较两次评测
pnpm tnega evolve run tasks.yml    # 运行真实 LLM 自进化闭环
```

不需要 API key 的快速试用：

```text
pnpm tnega eval run examples/tasks.yml
```

## 真实 LLM 接入

`tnega run` 默认通过 Anthropic Messages 协议调用 OpenCode Go 的 `minimax-m3` 端点。key 从环境变量或 tnega 系统配置读取，不写入代码或仓库文件：

```text
OPENCODE_GO_API_KEY=sk-xxx pnpm tnega run "Reply with: hello"
```

也可以使用 `OPENAI_API_KEY` 或 `DEEPSEEK_API_KEY` 作为兼容变量。系统配置文件位置：Windows 为 `%USERPROFILE%\.tnega\config.json`，Linux / macOS 为 `~/.config/tnega/config.json`，文件内可写 `apiKey`、`baseUrl`、`model`、`temperature`。优先级为命令行参数 > 环境变量 > 配置文件 > 默认值。

默认端点为 `https://opencode.ai/zen/go/v1`，默认模型为 `minimax-m3`（Anthropic Messages 协议，请求 `.../v1/messages`）；OpenAI 兼容回退默认模型为 `deepseek-v4-flash`。模型协议通过内置模型表自动选择，未知模型回退到 OpenAI 兼容协议。可通过 `OPENCODE_GO_BASE_URL`、`OPENCODE_GO_MODEL` 或 `--base-url`、`--model`、`--max-tokens`、`--temperature` 覆盖。

LLM 请求默认 120 秒超时，最多重试 2 次，采用 500ms 起步的指数退避；仅网络错误、408 / 425 / 429 / 5xx 会触发重试，401 / 403 等 4xx 和用户取消不会重试。可以通过 `--timeout-ms`、`--max-retries`、`--retry-delay-ms` 覆盖，`tnega run` 与 `tnega evolve run` 都支持：

```text
OPENCODE_GO_API_KEY=sk-xxx pnpm tnega run "prompt" --timeout-ms 180000 --max-retries 3
```

`run`、`evolve run` 与 `web` 均支持 `--config <file>`（或 `--config-file <file>`）指定配置文件。

会话记录默认写入 `.tnega/run.jsonl`，可以使用 `--session <file>` 指定位置。

## 内置工具

`tnega run` 默认挂载一个最小内置工具集，每个工具都是普通 `ToolDefinition`，通过 `builtinTools` 插件注册；插件卸载时工具自动注销，符合“工具也是可插拔”的架构。

默认工具：

```text
echo, now, calculator, json,
read_file, write_file, list_dir, glob, grep
```

高权限工具默认不注册：

- `http_get`：需要 `--allow-network`
- `shell`：需要 `--allow-shell`，工作目录被限制在 `--cwd` 内

文件工具使用路径沙箱：`read_file / write_file / list_dir / glob / grep / shell` 均被限制在 `--cwd` 内，拒绝绝对路径越界、`..` 越界与 symlink 越界。读取默认上限 256 KiB，写入与搜索默认上限 1 MiB，搜索结果默认 200 条，shell 默认 15 秒超时。

以插件方式接入时，`builtinTools` 接受 `BuiltinToolsConfig`：`cwd / allowNetwork / allowShell / disabled / maxReadBytes / maxWriteBytes / maxSearchBytes / maxResults / timeoutMs`，`disabled` 可进一步关闭任一内置工具。

`tnega evolve run tasks.yml` 把自进化闭环接到真实 LLM：baseline 和候选都由 LLM 驱动，提案规则要求 LLM 返回 JSON 形态的系统提示词候选，评测后由确定性 gate 决定接受或拒绝。实验树默认写入 `.tnega/experiments/log.json`，候选 run 写入 `.tnega/experiments/runs/`，文件中不含 key。

tasks.yml 支持候选声明；没有接入真实 LLM 时可以用内置确定性 loop 跑通完整评测链路：

```yaml
tasks:
  - id: echo-good
    inputText: good
    assertion:
      expect: good
candidates:
  echo:
    version: "1"
    loop: echo
defaultCandidate: echo
```

## 状态

- M1 core 时空语义：已完成。Context / Fiber / Effect / Event / Registry / Reflect 已落地，支持插件热插拔、失败回滚、依赖联动与 scope 隔离，配套 94 个 core 测试。
- M2 agent + tools + session：已完成。SessionLog 以 JSONL 记录可重放的会话事件并支持 fork / compact；ToolsService 提供注册表与可插拔执行管线；AgentService 提供可替换 agentLoop、inbox 与 fake LLM 端到端工具调用，配套 45 个测试。
- M3 eval 评测运行时：已完成。EvalRunner 在隔离子 Context 中加载候选，逐 task 创建独立会话与工具 scope，支持预算、缓存、持久化与 eval/* 事件；策略 assert / llm-judge / regression / all / weighted / gate 可注册、替换和卸载；CLI 支持 `tnega eval run` 与 `tnega eval compare`，配套 29 个测试。
- M4 evolve 进化循环：已完成。Candidate / propose / ExperimentLog 树提供候选生成与可回放实验；selection gate 支持 min-score、safety、退化阈值、显著性规则与审批 seam；确定性多轮闭环验证候选失败不影响主 runtime，配套 11 个 evolve 测试。
- M5 真实 LLM 接入：已完成。`@tnega/llm` 提供 OpenAI 兼容适配器与 `listModels`；`tnega run` 只从环境变量读取 key，支持模型、端点、温度、token 上限与 session 文件参数，配套 OpenAI 协议与 CLI 端到端测试。
- M6 时空可组合极端压力测试：已完成。新增 10 个压力测试，覆盖 100 次热插拔、20 代 provider 替换、128 插件级联、64 scope 隔离、64 fiber 并发挂载卸载、65 次健康检查拨动与 update 风暴。
- M7 真实 LLM 自进化闭环：已完成。`evolve run` 用真实 DeepSeek 驱动 baseline、提案与候选评测，gate 选择后持久化实验树；真实端到端实验与记录见 `docs/test/evolve-llm-e2e.md`。
- M8 最小内置工具集：已完成。`builtinTools` 以插件形式提供 `echo / now / calculator / json / read_file / write_file / list_dir / glob / grep`，`http_get` 与 `shell` 默认关闭，文件与 shell 工具受路径沙箱与字节/结果/超时上限约束；配套 16 个测试。
- M9 真实 LLM 工具调用端到端测试：已完成。mock 端到端 4 个测试覆盖 calculator / http_get / shell / 路径沙箱；真实 DeepSeek 冒烟 3 个测试覆盖 calculator / read_file / shell，session 记录 tool-call 与 tool-result，测试记录见 `docs/test/tools-llm-e2e.md`。
- M10 npm / pnpm 发布准备：已完成。`tnega` 根包发布为公共自包含 CLI，`bin` 指向 esbuild 打包的 `dist/bin.js`，`prepublishOnly` 自动构建并跑发布测试；npm 与 pnpm 本地安装验证通过，测试记录见 `docs/test/npm-publish.md`。
- M11 LLM 超时与重试：已完成。OpenAI 兼容适配器支持 120s 默认超时、最多 2 次重试与指数退避，只对瞬时错误重试；`run` 与 `evolve run` 均可通过 `--timeout-ms`、`--max-retries`、`--retry-delay-ms` 覆盖。
- M12 tnega web：已完成。`tnega web` 在 `127.0.0.1:3080` 提供浅色 manpage 风格 Web UI，支持多工作区、JSONL 会话、fork、token 级 SSE 流式聊天、每次运行的工具权限开关、系统级模型配置，以及 eval/evolve 只读仪表板。
- M13 agent core 对外边界：已完成。根包暴露库入口与完整类型；`defineAgent` 提供声明式 agent 契约，默认 loop 执行 hooks；`createAgentRuntime` 可注入 agent / inbox / sessionProjector / toolPolicy / contextBudget / builtinTools:false / plugins；session 支持可插拔投影器、context budget 与压缩 checkpoint 消息状态；tools 支持校验 / 授权 / 截断策略；发布包提供 10 个按域拆分的子路径导出并逐一验证消费者导入。
