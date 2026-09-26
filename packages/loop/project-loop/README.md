# `@tnega/project-loop`

Project 级的协作循环插件，装在 **Project 作用域**里，不是一条缝（没有自己的 Service
Definition）：它消费 Box、唤醒 Agent、驱动父子回报，并把结果交回给各自的 Agent Loop。

```
        ┌────────────── Project Loop ──────────────┐
用户 ⇄ Box ⇄ 投递 / 唤醒 / 发布 / 回报 ⇄ Thread ⇄ Agent Loop
        └──────────────────────────────────────────┘
```

## 它做的四件事

1. **投递**。把未确认的 Box 信封送进收件 Agent 的 durable inbox；收件 Session 准入并
   冲刷之后才 `ack`。`messageId` 已经在 Session 里出现过就只补确认 —— 恢复时重投的是
   「还没进入模型」的那部分。
2. **唤醒**。空闲的收件 Agent 用 `followup` 起一轮；运行中的用 `steer`，在下个安全
   step 边界进入，不打断正在进行的工具调用。
3. **发布**。Agent 的 Session 落入面向用户的回复后自动发布到 Box：根 Thread 发到主对话，
   子 Thread 发到它自己的面板。带工具调用的中间叙述不发布 —— 那是执行记录，不是对话。
4. **回报**。`complete` / `blocked` / `failed` / `request` 信封到达时更新发送方 Thread 的
   状态；子 Thread 自己没回报过时，用这轮的结论补一条 `complete` 给直接父 Agent，因此
   父 Agent 从不需要轮询子 Session。

## 关键取舍

- **不替代 Agent Loop**。它不调用模型、不改 Session 内容、不复制对话。每个 Thread 仍由
  自己的 Agent Loop 驱动，每个 Agent 恰有自己的 Session。
- **去重键是 Session 里的 Box ID**。投递时把 `messageId` 写进那条 user 消息的 `name`
  （`box:<messageId>`），Session 的 `user/message` 事件因此记下了「这条输入来自哪个信封」。
  Durable inbox 的 `content` 只接受模型消息数组，所以信封身份不能放进消息体；发送者也不
  另存一份 —— 它由 Box 里的同一个 `messageId` 决定，不复制就不会漂移。
- **发布 ID 由事件派生**。`sha256(projectId, agentId, sessionEventId)` 截断 32 位十六进制，
  于是同一段模型输出无论发布几次都是同一个信封，崩溃后重发被 Box 的幂等路径吸收。
- **恢复是增量的**。从 Session 尾部往回找第一条已发布的回复，它之后的就是欠发的部分；
  恢复开销随「欠发的量」增长，而不是每次都重扫整份历史。
- **状态由消息类型读出**。派工说明收件方开始工作，回报说明发送方自己的结论。模型不需要
  额外上报状态，UI 也不必从模型文本里猜。
- **状态转移按到达顺序处理**。`running` / `idle` 是一对异步事件；不排队就会让「跑完了」
  先于「开始跑了」落库，`idle` 被当成过期结论丢掉。
- **兜底重扫**。`box/sent` 与 `agent/status` 会立即触发扫描，定时器只覆盖「没有任何事件
  到达」的情况；`sweepIntervalMs: 0` 可关闭它（测试与嵌入式宿主会这么做）。
