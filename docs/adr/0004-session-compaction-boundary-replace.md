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
