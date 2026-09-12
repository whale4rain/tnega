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
  `followup`、`steer`、`inject`、`send`、`replaceMessage` 与 `removeMessage` 都返回
  `Promise<void>`：resolve 表示 splice 已 durable 且 live observation 已发出；reject 表示
  持久化失败（同时仍会发布 `agent/error`）。写入失败不会阻塞后续 mutation，也不会唤醒 agent。
  `agent/inbox/inserted.target` 对新消息是 API intent（`followup`、`steer` 或 `inject`）；
  replacement 则保留原消息的 durable target（`next-turn` 或 `next-step`）。

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

`agent/pre-step` 与 `agent/request` 使用异步 waterfall：监听器可以先 `await` 再改写
payload 并调用 `next()`；同步监听器的行为不变。driver 会等待 pre-step 完成后才写入
`step/start`，并等待 request 完成后才持久化最终请求信封或调用 adapter。

`run()` 和 `runStream()` 都会经过 `llm/stream`。适配器只有 `complete()` 时，driver 会把
结果规范化为内部 stream；`request/header` 与 `request/context` 始终记录 waterfall 改写后的
最终 messages、tools 与 route 配置。

## 可重连的 assistant stream

`runStream()` 在原有 LLM Stream Event 与工具事件之外发布
`{ type: 'assistant/stream', frame }`。每次调用尝试有独立的临时 `attemptId`；
`revision` 在同一个 `AgentService` 生命周期内严格递增，跨重试和 Agent Run
不重置。`start` 先于 stream 消费，`chunk` 按接收顺序携带 `index/time/chunk`，
`end.outcome` 只在 Session 提交后提供 `{ kind: 'committed', eventType, seq }`。
客户端可用 `(attemptId, revision)` 去重；这些临时身份不会写入 Session。

成功结果在 `assistant/message.stream` 保存 Session 定义的
`AssistantStreamRecord[]`。失败、重试以及未提交消息的取消尝试写入唯一的
`assistant/attempt`，并在 stream 末尾保存 `stream_error`。取消时已有的文本
前缀仍按原行为提交为 interrupted `assistant/message`，同时携带 stream。
`assistant/attempt` 不产生模型消息，重试输入仍由原有 durable surface 重建。

重连后使用 `assistantStreams(await session.read())` 按 durable 事件顺序取回
已提交消息和 attempt 的 stream 深拷贝，包括 compaction 遮蔽的旧消息；不读取
legacy `assistant/chunk`，它只作为文本增量的兼容投影保留。
`append()` 的提交指 Session 内存事实及广播完成；JSONL 落盘仍使用 `flush()`。

## 使用

```ts
import { Context, defineAgent, openaiCompatAdapter } from 'tnega'

const root = new Context()
await root.plugin(defineAgent({ name: 'coding-agent', system: '...' }), {
  llm: openaiCompatAdapter({ apiKey: process.env.TNEGA_API_KEY! }),
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
await handle.agent.followup({ text: 'do the thing' })
await handle.agent.whenIdle()
await handle.dispose()
```

## 测试

`packages/agent/test/`。agent 循环时序用 fake LLM 驱动；durable inbox 覆盖
insert/steer/claim/restore 的崩溃重建；live 测试覆盖 resume 后自动续跑。
