# Tnega

[English](../README.md)

Tnega 是 "agent" 的逆写，也是本项目想做的事：把 Agent 本身当作可以被观察、修改、回滚和进化的对象。

Tnega 是一个自研核心的 Agent Harness，参照 DeepSeek Harness 的时空可组合思想，同时把简洁性作为硬约束，并把 Eval 提升为与 Agent Loop、Tools 平级的一等公民。

## 为什么做 Tnega

- Agent = Model + Harness。模型负责思考，Harness 负责模型之外的一切：记忆、工具、权限、执行、评估。
- 大多数 Harness 是固定系统。Tnega 的目标是让 Harness 本身可以被安全地热插拔和回滚，从而为 Agent 自进化提供基础。
- dsh 证明了 "一切皆插件" 可以做到，但整个工程很大。Tnega 自研一个语义完整、体积可控的核心，再叠加薄业务层。

## 安装

需要 Node.js >= 22。

```bash
npm install -g tnega
# 或
pnpm add -g tnega
```

## 快速开始

```bash
export OPENCODE_GO_API_KEY=sk-...
tnega run "Reply with: hello"
```

`tnega run` 默认通过 OpenAI 兼容协议调用 OpenCode Go 的 `deepseek-v4-flash`；`minimax-m3` 走 Anthropic Messages 协议，同样内置在能力表中。key 也可以放在系统配置文件中：Windows 为 `%USERPROFILE%\.tnega\config.json`，Linux / macOS 为 `~/.config/tnega/config.json`，文件内可写 `apiKey`、`model`、`baseUrl`、`temperature`。优先级为命令行参数 > 环境变量 > 配置文件 > 默认值。

不需要 API key 的确定性评测：

```bash
tnega eval run examples/tasks.yml
```

启动本地 Web UI：

```bash
tnega web
# http://127.0.0.1:3080
```

Web UI 支持按会话选择 `general` / `coding` 两种 agent。coding 会话提供
`auto` / `plan` / `execute` 模式：plan 模式会在输入框上方展示 LLM 生成的
todo 计划，并随 `plan_execute_mark` / `plan_execute_result` 工具调用实时更新；
`/mode`、`/skills`、`/mcp` 等斜杠命令可直接从前端触发。

## CLI

```text
tnega run "prompt"                       # 运行一次 agent 会话
tnega run --allow-shell "list files"     # 开启高权限工具
tnega web                                # 本地 Web UI
tnega eval run tasks.yml                 # 运行评测
tnega eval compare <base> <head>         # 比较两次评测
tnega evolve run tasks.yml               # 运行自进化闭环
```

常用参数：`--model`、`--base-url`、`--max-tokens`、`--temperature`、`--cwd`、`--session`、`--timeout-ms`、`--max-retries`、`--retry-delay-ms`。会话默认写入 `.tnega/run.jsonl`，可使用 `--session <file>` 指定位置。

## 核心语义

- Context：运行环境与作用域树。服务查找沿父链向上，子 Context 可覆盖服务，隔离通过 scope 实现。
- Fiber：插件实例的生命周期。状态为 pending / loading / active / failed / unloading / disposed。
- Effect：每次修改都携带撤销函数，卸载时逆序执行，保证无残留。
- Event：emit / serial / bail / waterfall 四种派发模式，所有扩展点都是事件。

时空可组合：

- 时间可组合：组件可以热插入、热拔出、热替换，失败可回滚。
- 空间可组合：依赖齐备才激活，provider 消失时依赖方先停；不同 scope 拥有不同组合。

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

`tnega evolve run tasks.yml` 把自进化闭环接到真实 LLM：baseline 和候选都由 LLM 驱动，提案规则要求 LLM 返回 JSON 形态的系统提示词候选，评测后由确定性 gate 决定接受或拒绝。实验树默认写入 `.tnega/experiments/log.json`，候选 run 写入 `.tnega/experiments/runs/`，文件中不含 key。

## 模型与价格

能力表（`MODEL_CATALOG`）携带价格元数据，单位为每 1M token 的 USD，DeepSeek 模型区分 Peak / Off-Peak 两档；`monthlyUsage` 为 OpenCode Go 订阅每月包含的美元额度。Peak 时段为 UTC 周一至周五 01:00-04:00 与 06:00-10:00，其余时间（含周末）为 Off-Peak。

| 模型 | 档位 | Input | Output | Cached Read | Usage |
| --- | --- | ---: | ---: | ---: | ---: |
| MiniMax M3 | 单档 | $0.30 | $1.20 | $0.06 | $60 |
| DeepSeek V4 Flash | Off-Peak | $0.22 | $0.66 | $0.007 | $30 |
| DeepSeek V4 Flash | Peak | $0.44 | $1.32 | $0.014 | $30 |
| DeepSeek V4 Pro | Off-Peak | $0.66 | $1.98 | $0.022 | $15 |
| DeepSeek V4 Pro | Peak | $1.32 | $3.96 | $0.044 | $15 |

LLM 请求默认 120 秒超时，最多重试 2 次，采用 500ms 起步的指数退避；仅网络错误、408 / 425 / 429 / 5xx 会触发重试，401 / 403 等 4xx 和用户取消不会重试。可通过 `--timeout-ms`、`--max-retries`、`--retry-delay-ms` 覆盖。

## 内置工具

`tnega run` 默认挂载最小内置工具集，每个工具都是普通 `ToolDefinition`，通过 `builtinTools` 插件注册；插件卸载时工具自动注销，符合“工具也是可插拔”的架构。

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

## 作为库使用

`tnega` 从 0.1.0 起同时发布为库入口。外部 agent（包括独立仓库的 coding agent）可以直接依赖根包，用 `Context` 组装自己的运行时，不需要依赖内部 `@tnega/*` 包。发布包通过 `exports` 暴露 `dist/index.js` 与 `dist/types`，另有 `tnega/coding-agent` 等子路径，所有公共契约都有类型声明。

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
    version: '0.2.0',
    system: 'You are a coding agent.',
    tools: [],
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
- `SessionProjector` 与 context budget：`session` 插件可通过 `projector` 配置自定义 JSONL 事件到模型消息的投影；`SessionLog.deriveMessages()`、`estimateContext()` 与 `compact({ keepTokens })` 共用同一投影器。默认 loop 内置 context budget：传入 `contextBudget: { limit, compactRatio, keepTokens, summarize }` 后，每个 step 前会按 token 估算检查用量，超过 `compactRatio` 时先调用 `summarize`，再执行 `session.compact` 保留最近 `keepTokens`，并派发 `agent/context-compact` 事件。
- `ToolPolicy`：`validator`、`authorizer`、`truncator` 可配置在 `tools` 全局层，也可覆盖在单个 `ToolDefinition.policy`。执行顺序为 `pre-execute → authorizer → validator → execute → truncator → post-execute / result`；策略拒绝会返回 `ToolResult.ok === false` 而不是把异常抛给 agent loop。

另外 `createAgentRuntime` 支持直接注入 `agent`（`AgentDefinition` 或裸 agent 对象）、自定义 `inbox`、`sessionProjector`、`toolPolicy`、`contextBudget`、`builtinTools: false` 与 `plugins`，`llm` 也可由外部 provider 通过 `agentLoop` 提供。外部 agent 既可以只替换 loop 和工具，也可以组合整个 runtime 生命周期，并直接嵌入评测与进化闭环。

除根入口外，发布包还提供按域拆分的子路径导出：

```text
tnega/agent         # AgentLoop / AgentDefinition / AgentService / inbox / context budget
tnega/core          # Context / Fiber / Effect / Event / Registry / Reflect
tnega/session       # SessionLog / projector / compact / token 估算
tnega/tools         # ToolsService / ToolDefinition / ToolPolicy
tnega/eval          # EvalStrategy / Task / Verdict / EvalRun
tnega/evolve        # Candidate / ExperimentLog / propose / gate
tnega/llm           # openaiCompatAdapter / anthropicMessagesAdapter / 重试配置
tnega/cli/runtime   # createAgentRuntime 组合运行时
tnega/events        # EventsService / DispatchMode / Hook
tnega/services      # service / registry / reflect / logger
```

每个子路径都有对应的运行时 bundle 与类型声明，`test/publish.test.ts` 会以消费者身份逐一验证。

## 模块规划

| 包 | 职责 |
| --- | --- |
| core | Context / Fiber / Effect / Event / Registry / Reflect |
| agent | 最小 Agent Loop，作为可替换 service |
| tools | 工具注册与执行管线 |
| session | JSONL 事件日志，支持 replay / fork / compact |
| eval | 评测运行时：策略注册、任务执行、证据收集、判分、持久化 |
| evolve | 进化循环：生成候选、评估、比较、接受或拒绝 |
| llm | OpenAI 兼容 / Anthropic Messages 适配器，默认对接 OpenCode Go |
| cli | headless 命令行入口与 web 服务 |

## 与 dsh 的关系

- 理念参照 DeepSeek Harness 与 Cordis 的时空可组合。
- 核心语义自研，代码自维护，不依赖 Cordis 运行时。
- 暂时不做：子代理、插件市场、生产级沙箱、多模态。

## 开发

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

阶段计划与进度见 `task.md`，术语表见 `CONTEXT.md`，测试记录见 `docs/test/`，架构决策见 `docs/adr/`。

## License

MIT
