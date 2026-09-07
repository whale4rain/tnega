# Session compaction：surface 边界替换 + 重排写（v6）

compaction 原实现是**全量快照式**：`checkpoint.payload.messages` 固化「当前整条
surface」的快照（`projectEvents(events)` 全量，或调用方显式传入压缩后的消息）。
实测发现该建模产生三类可观测问题：compact 后 `surfaceEvents()` 与
`deriveMessages()` 分叉（checkpoint 不是 surface 节点，折叠器不认识裸
`'replace'`）；server 用过期 `surfaceEvents()` 的 seq 集过滤 raw events，
pre-compact 旧消息被当作仍有效而膨胀；`estimateEventTokens(checkpoint)`
统计快照全量，与仍保留的 raw 消息重复计 token。

## 决策

改为对齐 DSH 学习稿第 5 讲的**边界替换**语义（方案一），并把
`SESSION_FORMAT_VERSION` 升到 6，v5 旧日志（快照式 checkpoint）在 `init()`
以 `SessionFormatError` 拒绝（预发布期不做迁移）。

- `checkpoint.payload.messages` 从「整条 surface 快照」改为「压缩前缀」；
  `surfaceOp` 从裸 `'replace'` 改为折叠器可识别的
  `{ op: 'replace', start, end }`（start/end 是被遮蔽的 raw surface seq 范围）。
- `foldSurface()` 把带范围的 checkpoint 作为 surface 替换节点：移除遮蔽范围内
  的 surface 节点、以 checkpoint 自身 seq 占位，之后的 `user/message` 等照常
  append —— `deriveMessages()` / `surfaceEvents()` / web 投影共用同一折叠规则，
  compact 后三者一致。
- `compact()` 在调用方给出压缩前缀时做一次**日志重排写**：保留 head/元数据 →
  `compaction/start` → `checkpoint`（前缀 + 遮蔽范围）→ `compaction/end` →
  原序保留的 kept-tail 尾部消息 → 其余 raw 坐标事件；`resequenceEvents()` 重分配
  seq 并重映射 `sourceEventSeqs` 与遮蔽范围，`_replaceEvents()` 同步内存事实层与
  JSONL 文件。无压缩前缀时保留历史 marker 行为（整份投影原位追加，不丢数据）。
- `estimateEventTokens(checkpoint)` 只估压缩前缀，不再与 raw 重复。

## 后果

- 模型视图、UI/API 视图、token 估算三者共享同一套 surface 折叠，消除 compact 后
  的分叉与双计。
- 文件事件顺序改变：kept-tail 从 checkpoint 之前移到之后，旧 v5 语义失效 → bump
  v6 并拒绝旧日志。
- 旧 raw 事件仍保留在日志里可回放；`checkpoint.messages` = 压缩前缀。
- 回归测试覆盖：compact 后 derive/surface/不变量一致、嵌套 compact（二次压缩已
  压缩会话）、compact 后 reopen、v6 格式拒绝 v5 fixtures、web compact e2e 按新
  事件顺序重断言。

详见 `packages/session/README.md` 的 v6 节与 `packages/session/src/index.ts`。

---

## 更新（2026-09-08）：v6 → v7——surface 派生 + 纯 append-only，并接入默认 seam

v6 上线后对照 DSH 实际实现复核发现：v6 的 `deriveMessages()` 仍是**文件序
投影**，为了让投影等于 surface，每次真实 compact 都要整文件重写 + 重排 seq。
DSH 的根模型是**从 surface 节点折叠派生**（文件序 ≠ 模型序合法），因此天然
append-only、seq 永不可变。v6 治标（输出一致）但没治本（派生机制仍依赖
文件布局）。本更新采纳后置建议：

### 决策

1. **derive 迁到 surface 折叠**。`deriveSurfaceMessages()` 按 `foldSurface`
   的节点位置序逐节点派生；替换为**位置语义**（`start`/`end` 是首末被遮蔽
   surface 节点的 seq，嵌套压缩后可出现 `start > end`）。模型视图从此是
   surface 的纯函数，与 raw 文件序无关。
2. **compaction 改纯追加**。`compact()` 将 `compaction/start -> checkpoint ->
   compaction/end` 作为普通事件追加（广播、落盘照常）；kept-tail 留在原处，
   不再重排文件、不再重分配 seq。无前缀调用 = 无操作；有前缀但无历史可遮蔽时
   写入一个 rangeless checkpoint 作为 surface 前缀种子（step0 整段压缩场景）。
   保留尾部从新的 user turn 起锚定，避免孤儿 tool/result。
3. **assistant/message 自带 `toolCalls`**。工具调用随助理消息落库，派生不再靠
   相邻 `tool/call` 事件重组；`tool/call` 降为 log-only 关联记录。空内容且无
   调用的 assistant 消息在派生时跳过（max-token 截断不进 transcript）。
4. **`system/message` 纳入 surface 节点**。此前它被标了 `surfaceOp` 却不在
   fold 集合内（v6 中 derive 含 system、foldSurface 不含，是又一处双视图）。
5. **移除整数组 `SessionProjector` seam**。投影不再可插拔——它是 DSH 没有的
   自定义机制，且与"surface 是唯一派生源"冲突。
6. **`SESSION_FORMAT_VERSION = 7`**，≤6 旧日志 `init()` 拒绝（预发布期无迁移）。
7. **下游适配**：`cli/server.readSessionEvents` 按 surface 会话序返回事件
   （checkpoint 置于替换位置、丢弃被遮蔽消息与孤儿 tool/call），前端继续用
   `projectEvents` 渲染即可获得与 derive 一致的 transcript。
8. **seam 默认接线**：`createAgentRuntime` 默认挂载 `systemPrompt` 组装服务，
   并把 `ToolsService` 全部可执行工具注册为 schema 提供者；loop 的
   `_resolveAvailableTools` 只把"已声明且已注册"的工具给模型（消除
   schema-only stub 静默暴露），未挂载 prompt 时回退 `ToolsService.list()`。

### 后果

- seq 重新成为不可变日志位置；外部游标在 compact 后不再失效；compact 转换对
  `session/event` 订阅者可见；崩溃最坏只留孤儿 `compaction/start`，无整写撕裂。
- 模型视图 / `surfaceEvents()` / server 返回 / token 估算同源同序，机制上无法分叉。
- 代价与既有取舍：旧 v6/v5 真实会话日志不可打开；web transcript 依赖服务端
  排序后的 events（等价于 v6 的文件序行为）；多轮 queue-drain 的 `LiveAgent`
  注册表仍是库层能力，web/CLI 的"一次 run ≈ 一个 turn"路径保持不变（产品层
  未改，见 `docs/research` 对照结论）。
