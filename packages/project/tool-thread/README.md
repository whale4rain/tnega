# `@tnega/tool-thread`

Thread 相关能力的 **Consumer**：模型可见的 `spawn_thread`、`list_threads`、
`send_thread_message`。只依赖 `@tnega/thread` 与 `@tnega/box` 两份 Service Definition，
不 import 任何 Provider。

```
@tnega/thread (ctx.threads) ─┐
                             ├─→ @tnega/tool-thread
@tnega/box    (ctx.box)     ─┘
```

## 与 `spawn_subagent` 的分工

| | Thread | Subagent |
| --- | --- | --- |
| 用户可见 | 是：卡片、面板、可以直接留言与改向 | 否：只属于父 Agent 的执行细节 |
| 生命周期 | 持续存在，可以反复交代新工作 | 一次调用驱动的有界任务 |
| 消息 | 走 Box，带因果引用进入主对话时间线 | 走 durable inbox，只与直接父级通信 |

协调者要交给用户一件「之后还能继续谈」的工作，用 `spawn_thread`。

## 契约

- **派工即卡片**。`spawn_thread` 建立 Thread 后立刻发一条 `dispatch` 信封：收件人是子
  Thread，`placement` 是主对话，`threadId` 指向子 Thread。于是一条 Thread 在时间线上的
  位置就是派工发生的位置，UI 不需要从模型文本里猜。
- **回报即状态**。`send_thread_message` 用 `kind` 表达结论：`complete` / `blocked` /
  `failed` / `request` 由 Project Loop 读成 Thread 状态，模型不需要额外上报。
- **只走相邻**。父子之间才能互发；兄弟默认不互通 —— 共享结果先写 Blackboard，再由共同
  父 Agent 转发引用或启动下游 Thread。
- **不搬历史**。派工只带目标与期望回报，不携带父 Agent 的 Session 历史。
