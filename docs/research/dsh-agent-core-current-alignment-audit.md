# DSH Agent Core 当前语义对齐审计（post-v10）

> 2026-09-13；tnega `5228280` / Session v10；DSH `c291e7961a`。
> tnega 路径相对 `D:\task\tnega`；DSH 路径相对 `D:\task\deepseek-harness`。
> 本文核对上述 HEAD 的一手源码；没有改动实现或运行新增复现测试。
> “已对齐”限定于所列行为，不表示 API、事件 schema、存储格式完全相同。

引用简写：tnega 的 `live.ts`、`service.ts`、`types.ts`、`inbox-durable.ts` 均位于
`packages/agent/src/`，其 `test/` 位于 `packages/agent/test/`；`session/src/` 是
`packages/session/src/`，单列 `src/invariant.ts` 也指该 Session 包。DSH 的 `agent.ts`、
`inbox.ts`、`assistant-stream.ts`、`tool-calls.ts` 均位于 `packages/core/agent-loop/src/`；
`agent-loop/src/` 与 `session/src/` 简写分别以 `packages/core/` 为前缀。

## 结论

旧版 `32232fa` 审计已过时。v8–v10 已补齐 assistant attempt ledger/流帧、可 await 的
inbox mutation、失败回滚、原子 clear/claim、异步 pre-step/request，以及 scoped Session
通知。concludesTurn 也已能消费工具期间排队的 next-step。这些不再是当前缺口。

剩余重点是错误完成信号、attempt 提交拒绝、Live Agent claim/销毁的失败边界。
FIFO steer、stopping hook、sticky max-tokens 与同 turn claimed 通知还有真实差异。
并行工具调度、富 UserMessage.source、reconnect transport 仍是明确非目标。

## 1. Inbox：部分对齐

已对齐：

- followup → next-turn；steer/inject → next-step；inject 惰性，steer 写入成功后唤醒，
  abort 后 steer 进入 next-turn。tnega `packages/agent/src/live.ts:278-344`；DSH
  `packages/core/agent-loop/src/agent.ts:128-155,179-237`。
- replace 在修改前保留原 target；inject 的 observation intent 单列；普通 mutation
  返回 Promise，失败可 await，同时发布 agent/error，后续 mutation 不被失败毒化。
  tnega `live.ts:232-275,306-344`；DSH `agent-loop/src/inbox.ts:142-158,200-245`。
- claim 批次为全部 next-step 加一个 next-turn；v10 单一 `target: 'all'` + deleteCounts
  保证混合 claim 原子，整个读取/append/apply 串行化；clear 同样为单一事件。失败前不改
  内存队列。tnega `packages/agent/src/inbox-durable.ts:107-144,239-243`；DSH
  `packages/core/agent-loop/src/inbox.ts:99-115`。这是对 DSH 同步 splice 的异步 API 适配。
- resume 重建 inbox、双队列 claim 删除计数和剩余 steer wake。
  tnega `inbox-durable.ts:257-300`、`live.ts:749-752,804-851`。

真实剩余缺口：

- **P1：Live Agent claim 失败尚未完整收束。** `_streamTurns()` 在 claimBatch 前清除
  wake reservation，claim 又在 service 调用的 catch 之外。steer-only claim 失败时
  DurableInbox 保留数据，但当前实例失去 wake。自动 drain 的 `task.finally()` 派生
  Promise 没有 catch，且该失败不经 agent/error；若 next-turn 仍在，finally 继续安排
  wake，持续失败可能重复调度。tnega `live.ts:457-470,488-538,551-553`；同 turn claim
  也先清 wake：`live.ts:572-578`。DSH 在已打开 turn 的 try 内 claim，经 throwError 报告
  并在 driver 边界收束：`agent.ts:217-237,268-341`。v10 原子性修复未覆盖此 Live 边界。
- **P2：steer 顺序不同。** tnega 前插，因此连续 A/B 以 B/A 消费，后来 steer 也会越过
  先前 inject；DSH FIFO 追加。tnega `inbox-durable.ts:54-72`；DSH `agent.ts:128-146`
  使用 `splice(target, Infinity, ...)`。现有 tnega 测试明确断言 B/A：
  `packages/agent/test/inbox-durable.test.ts:23-35`。这是既有差异，不是 v10 新回归。
- **P2：同 turn claim 缺少 claimed 通知。** 首批会 emit，但 claimNextStepInputs 只返回
  输入。tnega `live.ts:507-516,572-578`；DSH 每次 claim 逐条发布：`inbox.ts:111-115`。
- **P2：claim 先于 turn/start。** tnega 先 durable claim 和 claimed，再调用 service
  写 turn/start；DSH 先开 turn 再 claim。claim 成功到 service admission 之间中断时，
  tnega 连该认领的 turn 审计边界也未建立。tnega `live.ts:504-526`、
  `packages/agent/src/service.ts:443-476`；DSH `agent.ts:268-302`。两者均可能在用户消息
  admission 前崩溃；此处不声称 DSH 会自动重排已认领消息。

## 2. Turn / step：部分对齐

- **已对齐：** concludesTurn 先认领 next-step，有输入则同 turn 继续。
  tnega `service.ts:771-803`；DSH `agent.ts:315-320,484-492`。
- **P2：concluding tool 且队列为空时跳过 stopping hook。** tnega 774–776 行直接 break，
  只有无工具分支执行 agent/turn-stopping；DSH 包括 concludes 在内的所有 turnEnds
  均先 stopping，再检查 listener 新加入的 next-step。tnega `service.ts:772-794`；DSH
  `agent.ts:315-320`。所以该 listener 不能在 tnega 的 concluding-tool 尾部追加同 turn 工作。
- **P2：max-tokens 非 sticky。** tnega 仅无工具且无 next-step 时设置 length，继续后的
  stop 会覆盖它；DSH 任意 step 达到 max-tokens 后，completed 不降级 turn reason。
  tnega `service.ts:759-801,825-837`；DSH `agent.ts:305-310,484`。
- **架构差异：** DSH pre-step 接收本批 UserMessage，返回 enter/reject；tnega 接收完整
  ModelMessage transcript，以空 messages 提前结束，无独立 blocked reason。tnega
  `types.ts:173-184`、`service.ts:291-319,496-509`；DSH `agent.ts:240-258,289-300`。
- **边缘差异：** DSH idle wake 已获得 driver reservation 后即使消息移除，也有零 step
  turn；tnega 必须队列非空才开 turn。tnega `live.ts:498-505`；DSH
  `agent.ts:179-183,294-299`。一般交互影响较小。

## 3. Scope、异步 hooks、request/replay：核心路径已对齐

- **已对齐：** scope 先于 Session/service 建立，LLM/tools/prompt/middleware 从 runtime
  scope 解析，Session event/flush 通知兄弟隔离、根可观察。tnega
  `live.ts:137-163,690-703,761-793`、`packages/session/src/index.ts:1046-1056`；DSH
  `packages/core/session/src/index.ts:44-81,1144-1160`。
- **已对齐：** pre-step/request await async waterfall；run/runStream 共用 stream driver，
  native stream 优先，complete fallback。tnega `service.ts:423-452,496-583`；DSH
  `agent.ts:240-258,352-400,530-549`。
- **已对齐：** 最终 envelope 在消费前冻结、持久化、检查 replay，短路 stream 也必须经过
  边界；异常 retry 从 requestedInput 副本重组，不晋升失败 partial，恢复 hook 取得最终
  失败 envelope。tnega `service.ts:512-646,909-1039`；DSH `agent.ts:352-463,552-617`。
- **契约澄清：** agent/request.messages 是只读快照，transcript rewrite 归 pre-step/
  llm-stream seam；不采用 request 返回的 messages 不是新缺陷。tnega
  `types.ts:186-192`、`test/agent.test.ts:1984-2010`；DSH request 只组 config：
  `agent.ts:530-549`。
- **P2：contextWindow 未绑定最终 adapter。** provider/model 来自 request options，容量
  来自 scoped LlmService 当前 routeCapacity，直接 adapter/middleware 路由可能记录过时
  容量。tnega `service.ts:964-975`；DSH 从 preparedCall 取得：`agent.ts:584-597`。
- **架构差异：** defineAgent 可替换 agentLoop 服务，但 Live factory 固定 AgentService，
  不是 DSH 的 live driver seam。tnega `packages/agent/src/definition.ts:63-73`、
  `live.ts:760-783`。

## 4. Attempt / retry / reconnect：主体已对齐，错误终态仍有缺口

- **已对齐：** attemptId、单调 revision、index/time、独立 stream 与 append 成功后
  committed end 已存在。成功落 assistant/message，异常失败/重试落 assistant/attempt，
  取消异常已有文字前缀则保留 interrupted message。tnega
  `service.ts:346-398,538-608,657-682,759-761`；DSH
  `packages/core/agent-loop/src/assistant-stream.ts:17-113`、`agent.ts:399-482`。
- **已对齐：** attempt 是 log-only，assistantStreams 从 raw committed message/attempt
  取得深拷贝，包含 compaction 遮蔽的历史。tnega
  `packages/session/src/index.ts:461-480,837-847`、`src/invariant.ts:177-224`。
- **P1：正常返回的 error/cancelled completion 不走失败结算。** message_stop.finishReason
  类型包含这两值，但 completionFromStreamEvents 仅折叠字段；driver 随后正常提交
  assistant/message，不触发 request-error。没有 stop 的空 stream 也默认得到 error
  completion；若有工具声明，仍可能执行工具。tnega `types.ts:6-25,62-65`、
  `service.ts:598-608,657-760,1206-1226`；DSH 终态 error/aborted 先写 attempt 再调用
  request-error：`agent.ts:442-463`。异常 partial 不污染 history 的现有保证未覆盖此路径。
- **P1：settlement append 拒绝后没有 abandoned end。** tnega settle await append 失败
  只抛出，不设置 ended、不发终态；Frame 类型只允许 committed。tnega
  `service.ts:377-388`、`types.ts:270-278`；DSH 会 emit `{ kind: 'abandoned' }`：
  `assistant-stream.ts:77-113`。已收到 start/chunks 的客户端无法从 attempt 帧判断其放弃。
  这是已有 framing 的失败闭合缺口，不是 transport 非目标。
- **部分对齐 / 架构差异：** tnega 归一化 stream 没有 DSH 的 rich ContentBlock、usage/
  replayState envelope；live 帧由 generator 交付，DSH 使用 scoped agent/assistant-stream。
  自动 run 消费 generator，不自动给观察 listener 转播帧。tnega `types.ts:21-73`、
  `service.ts:423-435`；DSH `assistant-stream.ts:116-143`、`agent.ts:380-386,466-481`。
- **明确非目标：** reconnect 网络 transport、富 UserMessage.source。边界依据：
  `docs/superpowers/specs/2026-09-11-dsh-p1-semantic-alignment-design.md:15-19`。
  该旧设计“不要新增 session format version”已被后续 v8–v10 实现和 ADR 取代。

## 5. Tools / cancel：串行落账已对齐，并发调度非目标

- **已对齐：** 每个已声明 tool call 先落 tool/call，再执行/拒绝/取消，最后 tool/result；
  未开始的取消 call 也有合成结果。tnega `service.ts:670-746`；DSH
  `packages/core/agent-loop/src/tool-calls.ts:7-10,114-120,262-265`。
- **明确非目标：** exclusive barrier、parallel-safe 有界滚动池、开始前重新分类和
  model-order commit。tnega `service.ts:683-743` 仍串行；DSH `tool-calls.ts:83-101,122-246`；
  范围依据同上述 design 第 17–19 行。
- **架构差异：** cancel 仍 void，立即 abort，异步 clear 失败走 agent/error；DSH 同步
  clear 后 abort。tnega `live.ts:317-367`；DSH `agent.ts:149-155`。不可把它与普通
  mutation 的 await 契约混为一谈。

## 6. Session recovery / fork / flush

- **已对齐：** cold load 修复 torn tail 与缺失 tool result/step-end/turn-end；已提交
  attempt 保留，ownership invariant 可检查。tnega
  `packages/session/src/index.ts:921-1000,1475-1525`、`src/invariant.ts:177-224`；DSH
  `packages/core/session/src/repair.ts:21-29,94-134`、`agent-loop/src/index.ts:887-899`。
  双方 ledger 都记录终态，不能声称硬崩溃前未结算的 attempt 身份已经 durable。
- **架构差异（repair）：** tnega 重写修复后 JSONL；DSH 经正常 handle append closers。
  tnega `session/src/index.ts:1516-1525`；DSH `agent-loop/src/index.ts:887-894`。
- **架构差异（fork）：** tnega 按 message lineage 选择历史，移除 turn/step/attempt/retry，
  已避免孤立 attempt；DSH 按连续 seq 前缀保留全部事件，拒绝 open-turn boundary。
  tnega `session/src/index.ts:1222-1266`；DSH `session/src/index.ts:1203-1263`。tnega message
  fork 不保真复制失败 attempt 审计历史，但不是已修复的 ownership bug 再现。
- **架构差异（flush）：** append commit 不是 fsync。tnega 自带 JSONL writer，flush
  等待它后同步 emit 通知；DSH await 所有 scoped durability listeners。tnega
  `session/src/index.ts:1100-1106,1164-1200`；DSH `session/src/index.ts:695-708,1144-1160`。
  scope 已对齐，不代表 tnega 会等待 async session/flush listeners。
- **P1：正常 Live Agent dispose 不关闭 owned SessionLog。** factory 自建 log，返回的
  dispose 只执行 agent.dispose；后者等待 inbox/drain/maintenance/scope disposer，未调用
  session.close/flush。待写尾部和写失败不在生命周期完成承诺内，文件 owner 也未由此释放。
  tnega `live.ts:411-429,700-703,811`；`session/src/index.ts:1417-1428` 的 close 才负责
  drain/release。DSH dispose 等待 handle.close 并保留失败：`agent-loop/src/index.ts:574-617`。
- **兼容性：** 当前 v10 拒绝旧格式，不原地迁移，旧日志留存，新建 Session。版本背景见
  `packages/session/README.md`、`docs/adr/0005-assistant-attempt-ledger.md`。

## 后续优先级

1. 统一 error/cancelled completion 与异常失败路径；补 append 拒绝后的 abandoned end。
2. 补 Live Agent claim containment/wake 恢复和 dispose 的 Session drain/close。
3. 对齐 steer FIFO、concludes stopping、sticky max-tokens、next-step claimed；另行明确
   零 step turn 与 pre-step blocked decision 的产品要求。
4. 将 request context 绑定最终 adapter；fork/flush/live stream 的 API 形态单独决策，
   不把并发工具或 transport 混入故障修复。

以上是静态源码结论；每项实施前需要针对触发条件的行为复现。已通过的 DurableInbox
原子性测试不能替代 Live Agent 故障边界测试。
