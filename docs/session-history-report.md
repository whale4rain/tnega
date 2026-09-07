# Session History Repair Report

## 结论

Web 对话“暂停后乱掉”的直接原因**不是前端渲染算法**，而是后端曾把
重复历史再次写入 session raw 日志。前端 transcript 直接从 raw events
重建，因此 raw 一旦重复，页面就显示重复用户消息。修复后，页面加载应
从“surface transcript”投影，避免再次被脏 raw 影响。

## 现在的 Session 实现

- `SessionLog` 是工作区内 `.tnega/sessions/*.jsonl` 的 append-only 事件源。
- raw 层保存 `turn/*`、`step/*`、`assistant/chunk`、`tool/*`、`meta` 等
  回放事件；surface 层只保存模型实际会看到的
  `user/message`、`assistant/message`、`tool/result`。
- `deriveMessages()` 从 surface 派生 LLM history；
  `request/header` + `request/context` 记录请求 envelope，供严格重建。
- compaction 使用 `checkpoint` 的 `surfaceOp: replace` 替换旧 surface 节点。
- `foldSurface()` 维护当前 surface 节点 seq；新增
  `SessionLog.surfaceEvents()` 返回这些节点对应的原始事件，
  作为页面 transcript 的可靠来源。

## 根因

旧 `_persistStepInput` 用文本 prefix/suffix 判断“哪些 user/system 已写入”。
同一句用户文本跨轮重复时（例如用户再次说 `hi`，或中断后继续发送近似内容），
文本匹配错位，会把整段历史再次 append。日志中每一轮都多出
上一轮 user/system，前端随之显示错乱。

Web GET `/sessions/:id` 过去只返回 raw `events`，前端直接
`projectEvents(events)` 渲染，因此没有“surface 支撑渲染”：
坏 raw 会直接进入 transcript。

## 修复

1. `packages/agent/src/service.ts`：不再使用 prefix/suffix 去重，改为
   按 surface 中 user/system 数量差只追加尾部真实新增。
2. `packages/session/src/index.ts`：新增 `surfaceEvents()`，返回 surface
   节点的原始事件。
3. `packages/cli/src/server.ts`：
   - GET `/sessions/:id` 返回干净 `events` 与新增 `surface`；
   - `events` 中重复的 user/assistant/tool-result 被过滤，
     `tool/call` 与 surface 节点仍保留，便于 UI 工具卡片配对。
4. `apps/web/src/types.ts`：`SessionDetail` 增加 `surface` 字段，
   为前端后续切换留好契约。

## 验证

- 真实损坏会话修复后 user 序列：
  `hi` → `你是谁` → `这个项目是什么` → `查看第一个项目` → `测试一下` → `project2现在有什么`。
- `surfaceEvents()` 对该会话返回 75 个节点：6 个 user、28 个 assistant、
  41 个 tool result，无重复历史。
- 新增 `SessionLog.surfaceEvents` 单元测试；
  agent 重复文本回归测试覆盖三轮。

## 待办

- 重启 Web 服务以使用修复代码。
- 前端可将整页 transcript 改为直接使用 `surface` 字段投影，
  当前阶段先由服务端返回干净 `events`，保证旧前端逻辑无需改动即可恢复。

---

## 追加（2026-09-07）：计数去重回归与根治

上一版「按 `user/system` 数量差只追加尾部新增」的修复仍有一个缺口：它把
requested 与 surface 都按 `user + system` **混合**计数。web 每次 resume 都会在
模型输入最前面放 run 级 system prompt（coding agent / plan 上下文），这些
system 不在 durable surface 里，把数量差撑大后，从尾部切片会连同真新消息前面的
旧 `user/message` 一起重新 append。实测会话 `d851027d`：日志里出现
`hi/read project1/test this project` 等前序 user 的重复事件，derive 有 8 条 user
（应 4 条）；plan 模式因多一个 run system 而更明显。前端渲染是对坏日志的忠实还原。

### 根治（`packages/agent/src/service.ts` `_persistStepInput`）

durable user 序列总是 requested user 序列的**前缀**（新 turn 恒在末尾），因此改为
**只按 user 计数对齐**，仅追加对齐点之后的新消息（user/system 都可，但 run 级
system 位于首个 durable user 之前、自然被跳过）；全新日志（surface 为空）仍整段
持久化，保住首个 `system/message` 与首条 user。

回归测试：`agent.test.ts` *does not re-append old user turns when a resumed run
prepends a run-scoped system prompt* —— 复现 resume 输入形状
`[run system, ...全量 derive history, 新 user]`，断言旧 user 不被重复 append
（已确认旧代码失败、新代码通过）。

### 附带（`packages/cli/src/server.ts` `handleRun`）

coding 会话首轮会把 coding system 持久化为 durable `system/message`，因此 resume
轮的 derive history 已经以它开头；服务端不再前置第二份 coding system，避免模型输入
重复（Anthropic 协议下避免 top-level system 被重复拼接）。
web e2e 两轮 coding run 断言第二轮请求里 `You are Tnega` 只出现一次
（已确认去掉该改动时失败）。

> 本轮 compaction 语义变更（checkpoint 全量快照 → surface 边界替换，v6）见
> `docs/adr/0004-session-compaction-boundary-replace.md` 与
> `packages/session/README.md`。
