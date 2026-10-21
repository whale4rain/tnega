# `@tnega/loop-guard`

把「一轮最多多少步」换成「多少步没有进展」。长任务只要还在推进就不打断；它要抓的是卡住。
通过 `ctx.plugin(loopGuard, config)` 挂载（Web 宿主经 `runtimeCapabilities` 的 `loopGuard: true`，
Project 宿主直接挂载）；Fiber dispose 时撤销全部监听。

## 检测（确定性，不调模型）

每个工具调用按「工具名 + 参数（键排序，字符串内容原样保留）」和「同一调用 + 结果」各取一个哈希，在最近 `window`（12）次调用里找：

- 同一调用得到同一结果 `sameResult`（3）次：最强信号，模型拿不到新信息。
- 同一调用 `sameCall`（6）次，即使结果不同。
- 连续 `sameError`（3）次同一错误（数字、地址抹平后比较）。
- 周期 A→B→A→B：调用 + 结果重复两圈，或仅调用重复三圈。
- 同一条 assistant 消息连续 `sameMessage`（3）次，且这几步都没有拿到新结果（读新文件时重复的客套话不算）。
- 看门狗：`stallSteps`（30）步没有进展。进展 = 进展类工具（写文件、改 checklist / goal、发布 artifact、
  发消息、`shell` 等，见 `DEFAULT_PROGRESS_TOOLS`）的一次**新**的成功调用（新的 shell 命令算，原样重跑同一条测试命令不算），或轮中有人（用户、其他 Agent）发来消息。
  原样重复的写入不算进展。

## 升级

触发后逐级升级，每级之间至少隔 `grace`（3）步，且模式要重新出现：

1. 提醒（`plugin:loop-guard`）：点名重复了什么，建议换方法或说明受阻。
2. 反思（`plugin:loop-guard:reflect`）：先写下试过什么、为何失败、接下来有何不同。
3. 暂停（`plugin:loop-guard:park`）：撤掉工具，让模型向用户汇报已完成、卡在哪、需要什么。

有进展就回到 0 级；被暂停的轮次里有人回复，就恢复工具。每条消息都经 `agent.steer` 进入 durable inbox，模型可见历史可由 Session 重建；
Timeline 把它们显示为提示而不是用户消息。

## 兜底

- 调用方没设上限时，把 `maxSteps` / `maxTurns` 的默认值从 64 提到 `backstopSteps`（500）。调用方自己的上限不变。
- 软上限：一轮的 token（未命中缓存的输入 + 输出，默认 4M）或时长（默认 2 小时）到了就直接暂停并请用户决定，而不是杀掉。设为 0 关闭。
- 本轮反复出现的失败（同一错误第二次出现）和触发过的检测，保留最近 `attempts`（10）条，新一轮开始时清空；上下文压缩后以 `plugin:loop-guard:attempts` 重新注入，避免摘要丢掉「什么已经不行」后重试。

## 依赖的通用挂载点（`@tnega/agent`）

- `agent/step-limits`：每次 Agent Run 开始前，插件可以填入调用方没设的步数上限（loop guard 先 `next()`，只填仍未设置的）。
- `agent/step-end`：每步 durable 结束后、领取下一步输入前等待，带本步 completion 与工具调用 / 结果。
- `agent/request`、`agent/tool-call`、`agent/tool-result`、`agent/context-compacted` 现在带 `agentId`。

监听器出错只记日志，不会让被观察的 turn 失败。
