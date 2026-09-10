# DSH agent-core 参考语义清单

> 调研日期：2026-09-11  
> 目的：以 DeepSeek Harness（DSH）学习文档为一手参考，列出 `agent`、默认
> `agent-loop` 与 `session` 事实层应具备的可观察语义，供 tnega 的
> `packages/agent` / `packages/core` 对照。本文不评价 tnega 是否已实现。
>
> 证据路径均相对于参考根目录
> `D:\ChromeDownloads\deepseek-harness学习文档\deepseek-harness学习文档\study`。

## 范围与术语

- Agent 是含 inbox、状态和执行 driver 的**存活运行时句柄**；Session 是与 Agent
  共用 id、但独立的 append-only 事件日志。前者管理 live 执行、后者保存 durable
  事实；Session 尚在即可重建 Agent。
  （[04-turn与step.md:11-19](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）
- turn 是从认领一批输入到不再“欠任何东西”的调度单位；step 是恰好一次模型请求及
  其发起的工具调用；message 只是事件记录。因此一条用户消息可导致零、一次或多次
  step。
  （[04-turn与step.md:15-26](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）
- `dsh-agent`（接口、inbox、`agent/*` 事件词汇）和 `dsh-agent-loop`（默认 driver）
  分离；driver 是可替换的消费者插件，而非 Agent 接口的固有实现。
  （[04-turn与step.md:138-142](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）

## 输入、排队与 turn/step 状态机

- 一切输入先进入 inbox，再由 loop 统一认领。`followup()` 入下一 turn 且唤醒
  driver；`steer()` 插入最近 step、空闲时亦可开 turn；`inject()` 只排入下一次
  pre-step 的模型可见上下文，不单独唤醒空闲 driver；`send()` 是可指定目标和唤醒
  策略的底层入口。
  （[04-turn与step.md:83-92](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）
- turn 先写 `turn/start`，认领 inbox；组装 prompt sections/tool schemas 后经过
  `agent/pre-step` waterfall。该钩子可改写或拒绝最终 messages；若首批输入被拒绝或
  改为空，turn 必须仍以 `turn/end` 收束，但不创建 step。
  （[04-turn与step.md:44-56](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）
- pre-step 改写的最终 messages 必须作为 durable `user/message` 写入，再从日志
  `deriveMessages()` 得到模型历史；这保证日志可重建模型实际输入。
  （[04-turn与step.md:96-100](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）
- 每个 step 的请求链是 `agent/request` waterfall（最终请求）再到 `llm/stream`
  waterfall（模型适配器调用）。流式输出写 `assistant/chunk*`，完成消息写
  `assistant/message`。
  （[04-turn与step.md:54-63](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）
- 模型的每个工具调用必须先记录 `tool/call`，经过 `tools/pre-execute`、
  `tools/execute`、`tools/post-execute` 三段 live waterfall，再记录 `tool/result`；
  调用意图和最终结果是 durable 事实，过程钩子不是。
  （[04-turn与step.md:64-71](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)，[04-turn与step.md:104-109](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）
- `step/end` 后，未消费工具结果需要 continuation 或 inbox 又有输入时，必须在同一
  turn 继续认领下一个 step；否则运行 `agent/turn-stopping` 的 serial 决策，首个
  “不停”结果可阻止结束，最终才写 `turn/end`。
  （[04-turn与step.md:71-78](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)，[04-turn与step.md:113-120](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）

## Durable 事实、live 扩展点与事件调度

- `turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是 durable Session
  events；`agent/*` 是运行时观察/拦截事件；能力缝事件（如 `tools/*`）也是 live。
  `session/event` 是 durable 事件写入日志后的 live 广播，而不是另一份事实。
  （[04-turn与step.md:30-40](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）
- 事件派发模式是公开契约：`emit` 同步通知且忽略返回；`parallel` 并发等待；
  `serial` 按序 await 并在首个 bail 值停止；`bail` 是同步 serial；`waterfall`
  是可修改参数、可包装返回值的洋葱中间件。waterfall 不调用 `next()` 即短路；
  协作监听者通常应调用 `next()`，拥有否决权的监听者可故意短路。
  （[03-Cordis插件框架.md:93-114](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/03-Cordis插件框架.md)）

## 错误、取消、崩溃与静止

- 请求失败后，当前 step 需关闭并进入 `agent/request-error` 恢复 waterfall；若无人
  处理，则 turn 以 durable 错误 reason 结束。重试边界本身也是 durable 事实。
  （[04-turn与step.md:124-131](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）
- 取消是独立的类型化 cause；同一活动操作的多个 cause 取第一个。无论取消来源，
  已打开的 durable turn/step/tool 结构都必须闭合收敛。
  （[04-turn与step.md:124-132](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）
- 进程崩溃可遗留未闭合 turn/torn tail；持久层加载时丢弃 torn tail，并用合成事件
  补足 `tool/result`、`step/end`、`turn/end { interrupted }`，使重放历史合法。
  （[04-turn与step.md:130-134](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/04-turn与step.md)）

## Session 事件溯源与一致性

- Session 只 append 不可变事件；任意当前状态都是 projection。append 在内存层完成
  验证、冻结、单调递增 `seq` 分配、surface 更新和 `session/event` 广播；已接受事件
  永不改变，`session.events` 是冻结快照。
  （[05-SessionLog事件溯源.md:20-29](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/05-SessionLog事件溯源.md)，[05-SessionLog事件溯源.md:46-52](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/05-SessionLog事件溯源.md)）
- 内存 append 与磁盘 durability 是不同 commit 点：持久化消费者异步批量落盘；需要
  已落盘保证的调用方必须 `await sessions.flush(session)`，以 `session/flush`
  checkpoint 排空缓冲。
  （[05-SessionLog事件溯源.md:31-42](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/05-SessionLog事件溯源.md)，[05-SessionLog事件溯源.md:48-54](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/05-SessionLog事件溯源.md)）
- raw log 永久保留全部事实；surface 是当前模型可见消息层。普通事件追加至 surface，
  compaction 通过 `surfaceOp: replace` 的 durable checkpoint 替换后续模型视图，
  不删除 raw 历史。
  （[05-SessionLog事件溯源.md:58-64](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/05-SessionLog事件溯源.md)）
- compaction 必须在不拆散 `tool/call`/`tool/result` 的安全边界；自动压缩只在活动
  turn 的安全点，手动压缩需要空闲准入；模型历史、人类 transcript、UI 投影必须各自
  明确读取 raw 或 surface。
  （[05-SessionLog事件溯源.md:65-89](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/05-SessionLog事件溯源.md)）
- 核心不变量是 **model-visible ⇔ logged**：所有进入模型请求的语义都必须有
  durable owner；新增模型可见输入必须新增 durable event。运行时 invariant 持续
  断言该规则，不能只依赖约定。
  （[05-SessionLog事件溯源.md:93-111](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/05-SessionLog事件溯源.md)）
- fork 复制日志到指定边界后各自追加；持久化、UI 投影、查询、标题和遥测是同一事实流
  的独立消费者，不应反向要求写入方维护多份状态。
  （[05-SessionLog事件溯源.md:20-29](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/05-SessionLog事件溯源.md)，[05-SessionLog事件溯源.md:136-148](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/05-SessionLog事件溯源.md)）

## 运行时扩展与生命周期边界

- 服务按名称、按 Context 作用域解析；相同服务名可在子作用域拥有不同 provider。
  必需依赖需显式声明在 `inject`，可选依赖用 `ctx.get()`；依赖图而非配置行序决定
  启动。重复注册同名服务须响亮失败。
  （[03-Cordis插件框架.md:23-39](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/03-Cordis插件框架.md)，[03-Cordis插件框架.md:43-64](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/03-Cordis插件框架.md)）
- 每次插件挂载生成 fiber，持有该次挂载所有 effects；卸载时按注册逆序执行并等待
  清理。服务注册、工具注册、事件监听和 `ctx.effect()` 资源都应随 fiber 回收。
  （[03-Cordis插件框架.md:122-135](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/03-Cordis插件框架.md)，[03-Cordis插件框架.md:150-157](../../../../ChromeDownloads/deepseek-harness学习文档/deepseek-harness学习文档/study/03-Cordis插件框架.md)）

## 对照时应逐项验证的边界

1. 一条输入在拒绝、tool continuation、steering、取消和崩溃时，turn/step durable
   边界是否都满足上述状态机。
2. 模型的最终请求能否只从 Session durable 事实重建，而不依赖瞬时内存/prompt 注入。
3. 事件模式、waterfall 短路和 serial bail 是否在类型/API 层可见且可测试。
4. append、broadcast、flush、reopen/recovery、fork、surface compaction 是否各自
   有清晰且不混淆的 commit/投影语义。
5. loop、LLM、工具、存储与扩展插件是否以接口/事件交互，且卸载不会遗留注册或资源。
