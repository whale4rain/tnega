# `@tnega/session`

Session 是 Tnega 的**消息历史真源**：一个工作区内以 JSONL 追加写入的
事件日志。任何进入模型请求的内容都必须能从日志重建，这是本包的设计不变量。

## Surface：唯一派生源

模型历史由**折叠后的 surface** 派生，而不是 raw 文件序：

- **Raw 层**：`session.read()` 返回追加的事件流（永不重写、永不重排，`seq`
  恒为日志长度、永不变）。`assistant/chunk`、`assistant/attempt`、`tool/call`、`turn/*`、`step/*`
  等只关心回放与 UI 还原的事件属于这里，不产生 LLM 消息。
- **Surface 层**：`session.deriveMessages()` 投影出模型实际看到的消息历史。
  `user/message`、`system/message`、`assistant/message`、`tool/result` 都是
  surface 节点；`deriveSurfaceMessages()` 按 **surface 位置序**（`foldSurface`
  的节点顺序）逐节点派生——一次替换可以把一条 seq 更高的事件放到它取代的
  位置之前，文件序 ≠ 模型序完全合法。

`foldSurface()` 折叠 `surfaceOp`/`sourceEventSeqs` 得到当前 surface 节点，
替换是**位置语义**（`start`/`end` 是首末被遮蔽节点的 seq，替换后可能数值
大于其后的节点）。每条 `assistant/message` 自带 `toolCalls`，所以工具调用
无需在投影期靠相邻的 `tool/call` 事件重组——节点自描述、可独立派生。

## 人类 transcript 与模型 surface 是两种投影

- **模型（`deriveMessages()`）**：走折叠后的 surface，compaction 遮蔽的历史
  对它不可见（`deriveSurfaceMessages`）。
- **人类 transcript（`transcriptEvents()`）**：面向 web/读者，compaction
  **从不隐藏历史**——被遮蔽的旧消息原样保留，live checkpoint 只在它取代的
  位置留下一条摘要 marker（嵌套压缩递归展开）。模型省上下文，读者不失忆。

## Compaction：append-only 边界替换（v7）

v7 起 compaction 是对齐 DSH 的**纯追加边界替换**：

- `compact()` 把 `compaction/start -> checkpoint -> compaction/end` 作为普通
  事件**追加**到日志尾：seq 不可变、永不整写、`session/event` 广播照常。
- `checkpoint.payload.messages` 只承载**压缩后的前缀**，`payload.surfaceOp`
  是 `{ op: 'replace', start, end }`——遮蔽首末两个 surface 节点 seq。
- 保留的最近消息**留在原位**（物理上仍在 checkpoint 之前），fold 把它排在
  checkpoint 节点之后：模型看到 `[前缀] + 之后的节点`，被压缩的旧 raw 事件
  原样保留供回放。
- 因此在任何时候 `deriveMessages()` 与 `surfaceEvents()` 都**共用同一套 surface
  折叠**、不会分叉；token 估算只数当前 surface。UI 的历史展示用
  `transcriptEvents()`（保留被压缩历史，见上），二者各司其职。

v6→v7 断裂点：v6 每次真实 compact 会整写文件并重排所有 seq；v7 改为
surface 派生 + 纯追加，并让 `assistant/message` 自带 `toolCalls`。

## Assistant attempt ledger（v8）

`assistant/attempt` 是一次未提交 `assistant/message` 的模型调用尝试的终态记录，
payload 为 `{ turn, step, stream }`。它保存失败、重试或取消时已收到的归一化
Stream Event，不生成模型消息、不加入 surface，也不计入模型上下文 token。

`AssistantStreamRecord` 由 Session 定义为 `{ time, chunk }`，数组顺序就是接收
顺序，保留每次增量边界；时间戳为非负安全整数，不要求跨记录单调（时钟可能回拨）。
`AssistantStreamChunk` 支持 `message_start`、`message_delta`、`toolcall_start`、
`toolcall_end`、`message_stop` 和带序列化错误的 `stream_error`。
工具参数必须是 JSON 可序列化值。调用方先将 provider 数据归一化，再写入 Session；
本包不依赖 Agent 或 provider 类型。

`checkAssistantAttempts()`（包含于 `runInvariants()`）检查记录所属的 turn 与 step
在该事件之前已开始、尚未结束，并校验 stream 形状。一次 step 可以保存多次失败
尝试；尚未收到分块的失败可以保存空数组。记录自身表示尝试已终结，因此不强制
stream 以 `message_stop` 或 `stream_error` 收尾。Agent 生命周期内的临时
attempt id 和 revision 不作为 Session 身份持久化。

## Atomic inbox clear（v9）

`agent/inbox/spliced` 的 `target: 'all'` 是清空 `next-turn` 与 `next-step` 的单一
原子 splice。它避免取消操作在第二个队列写入失败时留下半清空的 durable inbox；恢复时同一
event 会同时清空两个队列。

## Atomic inbox claim（v10）

`target: 'all'` 可携带 `deleteCounts: { nextTurn, nextStep }`，分别删除两个队列的
指定长度前缀；省略 `deleteCounts` 时仍表示清空两个队列。混合领取全部 next-step
输入与一个 next-turn 输入只追加这一条事件，append 失败时两个队列都保持原状。
DurableInbox 内部串行化每次修改和领取的读取、append 与队列更新，避免并发操作读到旧索引。
恢复 inbox 和唤醒状态时使用相同删除计数。append 仍是 Session 内存事实提交边界，
JSONL 落盘仍由 `flush()` 完成。

当前 `SESSION_FORMAT_VERSION = 10`。v10 新增 atomic inbox claim；v9 及更早日志在
`init()` 时会被 `SessionFormatError` 拒绝，原文件保持不变，明确不做原地迁移。
新工作使用新 Session，旧日志留存归档。决策背景见
[ADR 0005](../../docs/adr/0005-assistant-attempt-ledger.md)。

## 可重建请求

`request/header` 是一次请求的完整 envelope 快照：call config、渲染后的
system prompt 与组装后的 tool schemas。`request/context` 记录请求解析到的
provider/model/contextWindow。它们都是 log-only 事件（不产生 LLM 消息），
`foldRequestHeader()`/`foldRequestContext()` 取最新快照。这样一条请求可以由
`request/header` + `deriveMessages()` 严格重建。

`turn/start`/`turn/end`、`step/start`/`step/end` 携带显式坐标，`tool/result`
保留原始参数 JSON `argRaw`。

## 持久化与崩溃恢复

`SessionLog` 是内存事实层：`append()` 同步提交并广播 `session/event`，
底层异步批量写入 JSONL（`flush()` 冲刷）。`repairUnclosed()` 在加载时
为撕裂的 `tool/call`/`step/start`/`turn/start` 补写失败闭合事件，保证
一个崩溃后的日志仍能重建出一个关闭的 turn。`runInvariants()` 断言已加载
日志的 turn/step/tool-call 成对闭合且 seq 单调。

`forkAt()` / `lineage()` 基于事件 id 与 `parentId` 构造可复用的 fork 前缀，
不依赖全量 raw 顺序。

`new SessionLog(file, broadcast?, publicationContext?)` 可指定 live 通知的发布
Context；未提供自定义 `broadcast` 时，`session/event` 与 `session/flush`
经该 Context 分发。显式 `broadcast` 优先，既有独立构造与 Session 插件的默认
广播行为不变。Live Agent 在 Session 初始化前建立 runtime scope，使初始化
元数据及后续通知都隔离于兄弟 Agent，同时根监听器仍可观察所有 Agent。
该作用域只控制通知分发，不改变事件顺序、JSONL 写入、回放或文件级 Session 所有权。
