# `@tnega/box-blackboard`

`ctx.box` 的基于 Blackboard 的 Provider：信封与投递状态分别落在 `message` 与 `delivery`
两种记录里。

## 记录形状

| kind | id | data |
| --- | --- | --- |
| `message` | `messageId` | `BoxEnvelope` |
| `delivery` | `<messageId>:<收件地址键>` | `DeliveryRecord`（`status` / `attempts`） |

收件地址键是 `user` 或 `agent:<agentId>`（`addressKey`）。一次 `send` 用 `commitAll`
把信封和全部收件人的 `pending` 记录**同一批**写入。

## 取舍

- **信封与投递记录同一批提交**。否则崩溃恢复会看到没有投递目标的信封，或者有目标却没有
  内容的空投递。
- **`pending` 与 `delivered` 都是「未确认」**。`inbox` 返回两者，Project Loop 负责重投 ——
  至少一次投递的实现放在 Loop 里，Provider 只报告事实。
- **同 ID 重复 `send` 返回已有信封**。并发发布同一条消息时，输给条件提交的一方读回
  已有信封返回，而不是报错。
- **`ack` 之后不再变更**。重投与重复确认都是空操作；每次 `delivered` 记一次投递尝试。
- **`inbox` 需要扫描全部投递记录**。记录按 `<messageId>:<地址>` 命名，没有按收件人分区的
  索引；本地单机规模下这比维护第二份索引更简单，也不会出现两份状态不同步。
