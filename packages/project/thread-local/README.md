# `@tnega/thread-local`

`ctx.threads` 的本地 Provider：一个 Thread 一个文件夹，身份与状态记在 Blackboard。

## 落盘形状

```
<root>/agents/<threadId>/session.jsonl     # root = <workspace>/.tnega/projects/<projectId>
```

身份的其余部分（label、goal、expect、state、depth、permission、父子）是同一个
Blackboard 里的 `agent` 记录。`id` 由记录键提供，时间由版本记录提供。

## 取舍

- **两边各存各的**。可恢复配置在 Blackboard，模型历史只在该 Session 的 JSONL 里；两者
  通过 `threadId` 关联，不互相复制。这样「Blackboard 不复制完整对话」与「Session 是模型
  可见历史的真源」同时成立。
- **`ensureRoot` 只保证身份**。协调者 Thread 的记录与目录在第一次打开 Project 时建立，
  真正开始跑要等 `activate` —— 创建 Project 不该顺手拉起一个 Agent。
- **激活有单例保证**。同一进程里同一个 Thread 只会有一个 `LiveAgent`；并发 `activate`
  共享同一个 promise。恢复用 `AgentRegistry.resume`，因此回到的是同一个 Session。
- **只建到 Thread 那一层**。Provider 只创建 `agents/<threadId>/`；子目录由需要它的 Provider
  自己建。
- **委派只收窄**。权限取父子中更窄的一个；深度与并行数超限以 `THREAD_LIMIT` 拒绝，而不是
  排队等一个空位。
- **记录损坏时收窄而不是放宽**。`agent` 记录缺少或无法解析 `permission` 时按
  `read-only` 处理。
