# `@tnega/session`

Session 是 Tnega 的**消息历史真源**：一个工作区内以 JSONL 追加写入的
事件日志。任何进入模型请求的内容都必须能从日志重建，这是本包的设计不变量。

## 两个投影

同一个日志派生两种视图：

- **Raw 层**：`session.read()` 返回追加的事件流。`assistant/chunk`、
  `turn/*`、`step/*` 等只关心回放与 UI 还原的事件属于这里，不产生 LLM 消息。
- **Surface 层**：`session.deriveMessages()` 投影出模型实际看到的消息历史。
  只有 `user/message`、`assistant/message`、`tool/result` 三个 surface 事件会
  进入这个有序消息列表；`compaction/start` 之后的 `checkpoint` 带
  `surfaceOp: 'replace'`，用它替换的 seq 范围抹掉被压缩的历史。

`foldSurface()` 折叠事件的 `surfaceOp`/`sourceEventSeqs` 得到当前 surface 节点，
`isAppendSurfaceEvent()` 用来区分纯追加与替换。

## 可重建请求

`request/header` 是一次请求的完整 envelope 快照：call config、渲染后的
system prompt 与组装后的 tool schemas。`request/context` 记录请求解析到的
provider/model/contextWindow。它们都是 log-only 事件（不产生 LLM 消息），
`foldRequestHeader()`/`foldRequestContext()` 取最新快照。这样一条请求可以由
`request/header` + `deriveMessages()` 严格重建。

`SESSION_FORMAT_VERSION` 增到 `5`：`turn/start`/`turn/end`、`step/start`/
`step/end` 现在携带显式坐标，`tool/result` 保留原始参数 JSON `argRaw`。
旧版本日志在 `init()` 时会被 `SessionFormatError` 拒绝，携带可重建所需新字段。

## 持久化与崩溃恢复

`SessionLog` 是内存事实层：`append()` 同步提交并广播 `session/event`，
底层异步批量写入 JSONL（`flush()` 冲刷）。`repairUnclosed()` 在加载时
为撕裂的 `tool/call`/`step/start`/`turn/start` 补写失败闭合事件，保证
一个崩溃后的日志仍能重建出一个关闭的 turn。

`forkAt()` / `lineage()` 基于事件 id 与 `parentId` 构造可复用的 fork 前缀，
不依赖全量 raw 顺序。
