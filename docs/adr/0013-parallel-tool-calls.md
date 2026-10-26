# ADR 0013：并行工具调用按工具声明分组

> 状态：已采纳（2026-10）
> 相关：`docs/plans/tool-surface-and-fs-alignment.md` 阶段 G、`docs/adr/0007-tool-output-spill.md`

## 背景

一条 assistant 消息可以包含多个工具调用。tnega 一直按顺序逐个 `await`：
`packages/agent/src/service.ts` 里是一个 `for (const call of toolCalls)`。
于是「同时读四个文件」要付四次往返的墙钟时间，而它们本来互不相干。

`run_code` 内部同样串行（一条 `queue`），描述里明写 "Calls are serialized, including Promise.all"。
在此之前，唯一的并发手段是「另起一个执行单元」：`shell` 的 `runInBackground` 与 `spawn_subagent`。

## 决策

工具作者声明，调度器分组，模型无感。

1. `ToolDefinition.isConcurrencySafe?(input): boolean` 是**纯同步分类器**。
   只有返回 `true` 才加入并行批；省略、抛错、返回别的值都算独占。
2. 独占调用是**栅栏**：它在前面那批落定之后开始，后面那批在它之后开始。
   未知工具名同样当栅栏 —— 它的失败是普通工具结果，产出这个结果不该和别的东西竞争。
3. 分批按**位置**切连续区间，不重排。`Promise.all` 天然按输入顺序返回，
   所以结果回填仍是调用顺序，`agent/step-end` 的 `calls` 与 `result` 按下标配对的约定不变。
4. 整批先 `tool/start` + `tool/call` 落盘，再开始执行：日志与 UI 先看到「这一组在跑」。
5. 一个调用失败只结算成它自己的结果，不取消同批兄弟：**批是调度单位，不是事务**。
6. `tool/result` 与 `tool/end` 按调用顺序落，不按完成先后。

声明永不进模型可见的 schema（`schemas()` 只暴露 name/description/parameters）。

## 为什么不是别的做法

- **默认并行、显式声明独占**：加一个工具却忘了声明，两个写会静默互相覆盖。
  默认独占的代价只是慢，默认并行的代价是数据损坏，因此选前者。
- **按「读了什么」推断安全**：需要读工具的返回语义，无法在调度点同步判断，
  而且推断错了没有任何地方能纠正。
- **把并发交给模型（让它在 `run_code` 里 `Promise.all`）**：`run_code` 内部也是串行的，
  而且这会把「能不能并行」变成一个提示词问题。已否决。

## 当前声明为安全的工具

`read_file`、`list_dir`、`glob`、`grep`、`http_get`、`job_output`、`job_list`、
`office_read`、`office_inspect`。其余全部独占，包括 `shell`、`write_file`、`edit_file`、
`run_code`、`spawn_subagent`、`ask_user_question`、`job_kill`。

`read_file` 有共享写入 —— 观测记录（`agentId + 路径 → sha256`）——但它可交换：
两次读同一路径写的是同一个版本。

## 接受的一处代价

`job_output` 有一个「读到第几个字符」的游标。两个并发读**同一个** job 时，
取决于交错，新输出可能交付两次、也可能一次而另一个为空。两种情况都不丢内容。
测试断言的是「不丢」而不是「不重复」。划进独占的代价是把「读不同 job」也拖成串行，
收益为零，因此接受重复。

## 后果

- 新增工具时想让它并行，必须自己声明，并保证不改同级调用拥有的状态。
- `packages/fs/tool-fs/test/fs-tools.test.ts` 有一项守卫：读工具必须声明、写工具必须不声明，
  防止有人删掉声明后静默退回串行。
- `packages/agent/test/concurrency.test.ts` 用「同时在场峰值」度量真实并行，
  并覆盖位置对齐、栅栏、失败不连坐、按参数分类。
- 仍未并行的地方：`run_code` 内部的子调用、`tools/execute` 之外的审批等待。
  前者是有意的（脚本里顺序即语义），后者一次只有一个待答请求不构成瓶颈。
