# `@tnega/agent`

Agent 循环与活体 agent 生命周期。对应 DSH 的 `core/agent`（接口 + inbox +
`agent/*` 事件词汇表）与 `core/agent-loop`（默认 turn/step driver）—— 本包两者都在，
但 driver 本身可通过 `agentLoop` 服务替换。

## 核心概念

- **turn / step 状态机**：一次 run 从认领一批输入开始，`turn/start → step/start →
  user/message → assistant/* → tool/* → step/end` 可重复多轮，直到不再欠任何东西才
  `turn/end`。一条用户消息 ≠ 一次模型请求。
- **live / durable 分流**：`agent/*` 事件是 live（观察/拦截正在发生的事）；真正落日志的是
  session 的 durable 事件（`turn/*`、`step/*`、`user/message` 等）。模型看到的语义必须
  从 durable 重建（model-visible ⟺ logged），live 事件只承载引用。
- **inbox 边界**：`followup()` 留在下一 turn；`steer()` 与 `inject(input)` 都写入 durable
  `next-step` 队列。后者不会唤醒空闲 agent，二者在运行中都会在最近的 step 边界并入当前 turn。

## 三层组件

| 文件 | 角色 |
|---|---|
| `service.ts` | `AgentService`：run/runStream 的默认 driver，组装 system prompt、请求、工具执行、上下文预算与重试 |
| `definition.ts` | `defineAgent`：声明式 agent 插件契约（name/version/system/tools/loop/hooks） |
| `live.ts` | live agent 注册表 `ctx.agents`：create/resume/get/list/roots/isOwnedBy、`AgentHandle`、durable inbox 驱动 |
| `inbox-durable.ts` | `DurableInbox`：inbox 的 splice 日志化（insert/steer/claim/clear/replace/remove） |
| `prompt.ts` | `SystemPromptService`：可排序 prompt sections、tool schema 提供者、变量注入，`system-prompt/assemble` waterfall |
| `llm-service.ts` | LLM provider seam：多 provider 注册与 `current()` 切换 |

## agent/* 事件（waterfall 为主要拦截点）

- `agent/pre-step` — 内容进模型前最后一道闸：可改写 messages，可让 turn 零 step 收尾
- `agent/request` — 决定最终请求（messages/tools/options）
- `llm/stream` — 调 adapter，可包装/短路
- `agent/request-error` — 请求失败恢复缝（重试决策 `{ kind: 'retry' }`）
- `agent/turn-stopping` — serial：依序问"要停吗"，首个 bail 出"不停"就继续
- inbox 系列：`agent/inbox/inserted` / `claimed` / `discarded` / `spliced`

`run()` 和 `runStream()` 都会经过 `llm/stream`。适配器只有 `complete()` 时，driver 会把
结果规范化为内部 stream；`request/header` 与 `request/context` 始终记录 waterfall 改写后的
最终 messages、tools 与 route 配置。

## 使用

```ts
import { Context, defineAgent, openaiCompatAdapter } from 'tnega'

const root = new Context()
await root.plugin(defineAgent({ name: 'coding-agent', system: '...' }), {
  llm: openaiCompatAdapter({ apiKey: process.env.OPENCODE_GO_API_KEY! }),
})
const loop = root.get('agentLoop')
const result = await loop({ text: 'hi' })
```

live agent：

```ts
const handle = await root.get('agents').create({
  file: '/ws/.tnega/sessions/<id>.jsonl',
  sessionId: '<id>',
  llm: adapter,
})
handle.agent.followup({ text: 'do the thing' })
await handle.agent.whenIdle()
await handle.dispose()
```

## 测试

`packages/agent/test/`。agent 循环时序用 fake LLM 驱动；durable inbox 覆盖
insert/steer/claim/restore 的崩溃重建；live 测试覆盖 resume 后自动续跑。
