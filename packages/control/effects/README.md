# `@tnega/effects`

控制缝的 **Service Definition**：拥有 `ctx.effects`（v2 server MVP §4.2 与 §4.5）。

- **Effect**：服务器要对外做的事（启动 box、唤醒一次运行、通知……），先存再做。`kind` + `key` 唯一：同一个决定重试时不会做两次。处理器在存下之后运行；成功删除，失败按 2 秒起、翻倍到 60 秒的退避重试；连续失败 3 次算一个问题（`problems()`），给管理页显示。处理器必须可重复执行：外部动作成功、删除前崩溃，会再跑一次。
- **Schedule**：周期条目（`kind` + `key`、spec、下次运行时间）。到期时在一个事务里认领：插入一个以「条目 + 运行时刻」为键的 effect，并把条目移到下一次，所以同一时刻不会跑两次，即使有两台服务器。错过的多次只补跑一次。条目种类由 `scheduleKind` 注册：到期时插入哪种 effect、下一次在什么时候。

Provider：`@tnega/effects-pg`（Postgres，由 `packages/runtime` 的 `controlCapability` 在状态在 Postgres 时挂载）。本地模式不挂，Routine 在 Project 打开时自己计时。
