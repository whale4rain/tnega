# `@tnega/tool-box`

Box 的 **Consumer**：模型可见的 `send_project_message`。只依赖 `@tnega/box` 与
`@tnega/thread` 两份 Service Definition。

```
@tnega/box    (ctx.box)     ─┐
                             ├─→ @tnega/tool-box
@tnega/thread (ctx.threads) ─┘
```

## 为什么只有一个工具

一轮执行结束时的回复由 Project Loop 从 Session 自动发布，不需要模型调用工具。这个工具
只用于**执行途中**主动说话：长活里的进度、需要用户拍板的选择、已经看出来的风险。

## 契约

- **发送者由作用域绑定**。工具参数里没有 sender：模型不能伪造成用户发言，也不能替别的
  Thread 说话。
- **落点是它自己的时间线**。根 Thread 的发言进入主对话；子 Thread 的发言进入它自己的
  面板 —— 用户在主对话里看到的是协调者的汇报，而不是每个子 Agent 的每句话。
- **用户会回话**。用户的主对话发言作为新信封回到收件 Agent 的 inbox，不需要在这里等待
  或轮询回复。
