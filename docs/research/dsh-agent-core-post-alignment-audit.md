# DSH Agent Core 对齐后语义审计

> 审计日期：2026-09-11  
> 对比基线：tnega `486dd8f`（工作树 `agent-core-semantics`）与
> `D:\task\deepseek-harness` 的一手源码。  
> 范围：运行调度、durable inbox/replay、取消/重试、stream 和工具事件；本文件仅报告
> 仍未对齐点，不修改实现。

## P1 — agent scope 没有包住实际执行服务

DSH 构造 loop 时以 agent scope 的 `ctx` 创建 inbox、runtime projection 和事件
dispatch，后续 pre-step 与工具执行均经该 loop context；因此 setup 的 agent-scoped
服务和监听器只影响该 agent（`D:\task\deepseek-harness\packages\core\agent-loop\src\agent.ts:96-111,240-255,488-491`）。

tnega 先在父 `ctx` 上创建 `AgentService`，之后才创建 `agentScope`；`LiveAgentImpl`
也把父 `ctx` 作为自身 `ctx`，仅把另一个 `agentCtx` 暴露给 setup（`packages/agent/src/live.ts:677-705`）。
所以在 `setup(agentCtx)` 注册的 scoped LLM、tools 或 `llm/stream` / tool middleware
并不在实际执行路径上，多个 agent 仍共享 root 服务与事件域。

## P1 — idle `steer()` 被误当成惰性 inject，不会开启 turn

DSH 的 `steer()` 是 wakeup 输入：在空闲时立即启动 driver；`inject()` 才是唯一
不唤醒的 `next-step` 写入（`D:\task\deepseek-harness\packages\core\agent-loop\src\agent.ts:181-190,218-236`；
`D:\task\deepseek-harness\packages\core\agent-loop\tests\loop.spec.ts:900-925`）。

tnega 最近为避免 inject-only 队列单独运行，把 drain 的首个 batch 限制为必须存在
`nextTurn`。因此 idle `steer()` 虽写入并触发 `_wake()`，`_streamTurns()` 仍立刻退出
（`packages/agent/src/live.ts:238-262,425-438`）。需要持久化/内存中的 wake reservation
来区分“可开 turn 的 steer”与“只等待自然 wake 的 inject”，而不是仅以队列 target 判断。

## P1 — `run()` 没有在 adapter 支持时采用同一原生 stream 管线

DSH 的 loop 对每个模型请求都消费 stream，非流式消费者只是消费该 stream 的另一层接口
（`D:\task\deepseek-harness\packages\core\agent-loop\src\agent.ts:390-400`）。这保证
stream 生命周期、chunk 与失败语义不会因调用入口不同而变化。

tnega 的 `run()` 显式传入 `false`，使 `_stream()` 忽略已实现的 `llm.stream` 而改走
`completeAsStream()`；只有 `runStream()` 才调用原生 stream（`packages/agent/src/service.ts:322-352,452-456`）。
这不满足“缺少 stream 时才将 complete 规范化”的对齐目标，且会丢失 provider 流特有行为。

## P1 — 取消中的 steer 会滞留在 next-step，不能开启后续 turn

DSH 在写 inbox 前同步检查活动是否已经 abort：唤醒型输入会重分类到 `next-turn`，并在
driver 收束后重新 wake（`D:\task\deepseek-harness\packages\core\agent-loop\src\agent.ts:128-146,187-207,225-236`）。

tnega 的 `steer()` 始终异步写入 `next-step`，并只在写后尝试 `_wake()`；正在 drain 时
该 wake 会被拒绝。drain 的下一轮又要求 `nextTurn` 非空，因此在已取消请求期间 steer 的
唯一输入会永久留在 `nextStep`，直到日后另一个 followup 到达（`packages/agent/src/live.ts:238-262,395-415,425-475`）。

## P1 — 取消后的模型多工具调用没有完整的 call/result 落账

DSH 按执行模式调度工具：abort 后停止新 dispatch、等待已启动调用，并对每一个未启动的
模型 call 写合成的 aborted `tool/call`/`tool/result` 对，以保持 replay 完整
（`D:\task\deepseek-harness\packages\core\agent-loop\src\tool-calls.ts:83-101,199-242,249-289`）。

tnega 对模型返回的 `toolCalls` 串行 `await`，循环顶端没有 abort gate；若第一个调用
期间取消，随后因 signal 已 abort 而跳出，剩余模型 call 只有 assistant message 内的声明，
没有 durable `tool/call` 或 `tool/result`（`packages/agent/src/service.ts:542-605`）。这还
缺失 DSH 的 parallel/exclusive barrier 与有界并发语义。

## P1 — 最终模型 transcript 的可重放性仍是可选检查，且可被 waterfall 破坏

DSH 在每次 loop-built `llm/stream` 前强制检查 request 的 frozen messages、session
id、session-derived transcript 和 request header；监听器短路也不能绕过该 invariant
（`D:\task\deepseek-harness\packages\core\agent-loop\src\invariant.ts:19-56`）。

tnega 只在 `assertReplayable` 配置开启时断言（`packages/agent/src/service.ts:461-465,875-912`）。
此外 `llm/stream` 可以改写完整 `messages`，但持久化只会追加 user/system，无法为 listener
插入的 assistant/tool 消息建立 durable owner（`packages/agent/src/service.ts:445-457,831-872`）。
默认配置下，这会把实际 adapter request 与 `session.deriveMessages()` 分叉；现有 assertion
还主动忽略 system transcript 内容（`:880-902`）。

## P1 — 流失败重试把未完成文本写入下一次模型上下文

DSH 对 error/aborted stream attempt 写不可见的 `assistant/attempt` 后进行 recovery，并直接
重试该 request；仅真实取消才保留可见安全前缀（`D:\task\deepseek-harness\packages\core\agent-loop\src\agent.ts:399-463`）。

tnega 只要失败前收到了 delta，便写入 `assistant/message { interrupted: true }`，重新
`deriveMessages()` 后进入 retry（`packages/agent/src/service.ts:481-531`）。所以网络/提供方
错误的 partial output 会被作为历史发送给重试模型，改变本应同请求的 retry 语义。

此外，retry 的下一次 `llm/stream` 输入基于上一 attempt 已被 waterfall 改写的
`llmMessages`，而不是该 step 的稳定 admitted transcript（`packages/agent/src/service.ts:445-465,481-531`）。
非幂等 listener（例如 append 一条路由提示）会在每次 retry 再叠加一次，令 adapter 实收
请求和持久化的“最终请求”都偏离初始 step。

## P2 — 失败 attempt 与可重连流协议未被 durable 表达

DSH 的每个 assistant attempt 都有 agent-local `attemptId`、单调 revision、chunk index，并且
在 durable `assistant/message` 或 `assistant/attempt` 提交后才发布终态（`D:\task\deepseek-harness\packages\core\agent-loop\src\assistant-stream.ts:17-113`）。

tnega 向调用者透传 provider-shaped stream event；仅 native text delta 零散写
`assistant/chunk`，不记录 tool/usage/replay chunks，空输出失败也没有 durable attempt
settlement（`packages/agent/src/types.ts:35-93`; `packages/agent/src/service.ts:467-489`）。
因此不能安全重连、去重或在 replay 中区分“模型未尝试”和“已尝试但失败”。

## P2 — recovery hook 收到的是 waterfall 前请求，而非失败 attempt 的有效信封

DSH recovery 的 provider/failure 来自该 attempt 构建的 request，retry 会重新 prepare request
（`D:\task\deepseek-harness\packages\core\agent-loop\src\agent.ts:441-463,500-504`）。

tnega 虽把 `llm/stream` waterfall 后的 `streamRequest` 交给 adapter 并记录它
（`packages/agent/src/service.ts:445-465`），catch 中的 `agent/request-error` 却仍从
waterfall 前的 `request.tools`/`request.options` 构造（`:496-511`）。例如 listener 切换
provider/model 后 adapter 失败，恢复策略看见的仍是旧 provider/model，可能选择错误重试路由。

## P2 — pending next-step 的 replace 事件目标总会退化为 next-turn

DSH 在替换前定位旧 id，并在同一 target/index 原地 splice（`D:\task\deepseek-harness\packages\core\agent-loop\src\inbox.ts:136-146,178-185`）。

tnega 先执行 durable replace，再拿**旧** id 调 `_findTarget()`；旧 id 已不存在，因而 inserted
live event 的 `target` 总回退成 `next-turn`（`packages/agent/src/live.ts:186-210,277-281`）。
对 next-step/steer item，这使 UI 或队列控制投影得到与 durable 状态不一致的目标。

## P2 — send/steer 的 durable 写失败对调用方不可观察

DSH inbox mutation 只在 session append 成功后发 `agent/inbox/inserted`，append 异常同步向上
传播（`D:\task\deepseek-harness\packages\core\agent-loop\src\inbox.ts:200-245`）。

tnega 的公开方法返回 `void`，异步 durable write failure 被捕获后仅 emit `agent/error`
（`packages/agent/src/live.ts:182-184,238-263`）。调用者不能得知输入没有持久化，却可能已把
send/steer 当作成功；这削弱了“durable before wake”的可观察契约。
