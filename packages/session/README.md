# `@tnega/session`

Session 是 Tnega 的**消息历史真源**：一个工作区内以 JSONL 追加写入的
事件日志。任何进入模型请求的内容都必须能从日志重建，这是本包的设计不变量。

## 两个投影

同一个日志派生两种视图：

- **Raw 层**：`session.read()` 返回追加的事件流。`assistant/chunk`、
  `turn/*`、`step/*` 等只关心回放与 UI 还原的事件属于这里，不产生 LLM 消息。
- **Surface 层**：`session.deriveMessages()` 投影出模型实际看到的消息历史。
  只有 `user/message`、`assistant/message`、`tool/result` 三个 surface 事件会
  进入这个有序消息列表。

`foldSurface()` 折叠事件的 `surfaceOp`/`sourceEventSeqs` 得到当前 surface 节点，
`isAppendSurfaceEvent()` 用来区分纯追加与替换。

## Compaction：surface 边界替换（v6）

v6 起 compaction 是对齐 DSH 的**边界替换**语义，而非整份快照：

- `compact()` 写入 `compaction/start -> checkpoint -> compaction/end`。
- `checkpoint.payload.messages` 只承载**压缩后的前缀**（通常是总结消息 +
  少量保持的最近上下文），`payload.surfaceOp` 是
  `{ op: 'replace', start, end }`——被它遮蔽的 raw seq 范围（被压缩掉的旧消息）。
- 保留的最近消息以**尾部事件**形式排在 checkpoint 之后，投影从
  `checkpoint.messages` 出发、把尾部消息继续 append：模型看到
  `[前缀] + 之后的消息`，被压缩的旧 raw 事件仍留在日志里供回放。
- 因此 `deriveMessages()`、`surfaceEvents()` 与 UI 投影**共用同一套 surface
  折叠**，compact 后三者一致；token 估算只数前缀，不与 raw 重复。

`SESSION_FORMAT_VERSION = 6`（v5→v6 断裂点即此 compaction 语义：v5 的
`checkpoint` 内嵌整份 surface 快照）。旧版本日志在 `init()` 时会被
`SessionFormatError` 拒绝。

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
