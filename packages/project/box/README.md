# `@tnega/box`

Project 内消息通道的 **Service Definition**：拥有 `ctx.box`。

## 这是一条缝的哪一个角色

本包是能力缝三角色里的 **Service Definition**。它是一条**抽象 Cordis `Service`**，
不是 TypeScript `interface` —— 抽象类才能拥有 `ctx.box` 这个键，也才能让 Provider
通过 `extends` 完成注册。

```
@tnega/box-blackboard (Service Provider) ─┐
                                          ├─→ @tnega/box (ctx.box)
@tnega/tool-box        (Consumer)       ──┘
```

## 契约

用户输入、协调 Agent 对用户的回复、父子 Agent 通信、用户对 Thread 的留言，全都是同一种
东西：一个带来源、收件人和因果引用的信封。用户也是收件地址之一 —— 主对话是「用户已发送
的消息与其 inbox 的投影」，没有第二条消息捷径。

- **至少一次投递**。`send` 只把信封和每个收件人的待投递记录写进 Blackboard；投递由
  Project Loop 完成，收件 Session 以 `messageId` 去重、准入并冲刷之后才 `ack`。重启后
  未确认的消息会被重投，已进入模型的不会再次进入。
- **不用回复当发送成功**。信封落盘即发送成功；`inbox` 报告的是「还没确认的消息」，
  不代表收件方已经处理。
- **发送者不可伪造**。`sender` 由宿主或 Agent 作用域绑定；模型可见的工具不暴露这个字段。
- **幂等**。`messageId` 可由调用方给定。自动发布的 assistant 消息用 Session 事件派生的
  稳定 ID，因此崩溃后重新发布得到同一条消息，不产生第二条，也不会把已确认的投递重置。
- **不存对话**。信封是传输事实；收件 Agent 实际看见的内容仍以它自己的 Session 为准。

## 事件面

`send` 是基类上的模板方法，落盘成功后统一派发只读的 `box/sent`（`{ envelope }`）。
Provider 只实现 `runSend`，因此任何 Provider 都自动参与该事件。观察者失败被吞掉 ——
事件用来观察**已落盘的信封**，不用来改写投递结果。Project Loop 靠它唤醒收件 Agent，
冷启动与崩溃恢复则靠 `inbox` 扫描，两者不互相依赖。
