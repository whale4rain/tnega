# `@tnega/session`

Session 是 Tnega 的**消息历史真源**：一个工作区内以 JSONL 追加写入的
事件日志。任何进入模型请求的内容都必须能从日志重建，这是本包的设计不变量。

## Surface：唯一派生源

模型历史由**折叠后的 surface** 派生，而不是 raw 文件序：

- **Raw 层**：`session.read()` 返回追加的事件流（永不重写、永不重排，`seq`
  恒为日志长度、永不变）。`assistant/chunk`、`tool/call`、`turn/*`、`step/*`
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

## Compaction：append-only 边界替换（v7）

v7 起 compaction 是对齐 DSH 的**纯追加边界替换**：

- `compact()` 把 `compaction/start -> checkpoint -> compaction/end` 作为普通
  事件**追加**到日志尾：seq 不可变、永不整写、`session/event` 广播照常。
- `checkpoint.payload.messages` 只承载**压缩后的前缀**，`payload.surfaceOp`
  是 `{ op: 'replace', start, end }`——遮蔽首末两个 surface 节点 seq。
- 保留的最近消息**留在原位**（物理上仍在 checkpoint 之前），fold 把它排在
  checkpoint 节点之后：模型看到 `[前缀] + 之后的节点`，被压缩的旧 raw 事件
  原样保留供回放。
- 因此在任何时候 `deriveMessages()`、`surfaceEvents()` 与 UI 投影都
  **共用同一套 surface 折叠**，不会分叉；token 估算只数当前 surface。

`SESSION_FORMAT_VERSION = 7`（v6→v7 断裂点：v6 每次真实 compact 会整写文件
并重排所有 seq；v7 改为 surface 派生 + 纯追加，并让 `assistant/message` 自带
`toolCalls`）。旧版本日志在 `init()` 时会被 `SessionFormatError` 拒绝。

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
