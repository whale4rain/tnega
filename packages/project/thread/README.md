# `@tnega/thread`

Thread 生命周期的 **Service Definition**：拥有 `ctx.threads`。

## 这是一条缝的哪一个角色

本包是能力缝三角色里的 **Service Definition**。它是一条**抽象 Cordis `Service`**，
不是 TypeScript `interface` —— 抽象类才能拥有 `ctx.threads` 这个键，也才能让 Provider
通过 `extends` 完成注册。

```
@tnega/thread-local (Service Provider) ─┐
                                        ├─→ @tnega/thread (ctx.threads)
@tnega/tool-thread  (Consumer)        ──┘
```

## Thread 是什么

一个 **Agent 身份**：稳定 ID、一个文件夹、一个 Session。它不是一次任务 —— 用户可以从
主对话卡片再次进入同一个 Thread 补充要求，回到的是同一个 Agent。需要彻底重启上下文或
更换不兼容配置时，创建有来源链接的新 Thread，而不是在一个 Thread 下面套第二个 Session。

父 Agent 承担主对话或上一级工作；子 Thread 是它的后代。父子关系是 Blackboard 里的持久
事实，重启后整棵树都能重建。**父子树决定谁可以下指令与接收回报**；「B 要用 A 的结果」
这类依赖是另一回事，记在 Blackboard 的 `dependency` 记录里，两者不混用。

## 契约

- **父 Agent 不同步等待**。`spawn` 立刻返回；子 Agent 的结果由 Project Loop 通过 Box
  送回父 Agent 的 inbox。等待不占用模型调用。
- **委派只收窄**。子 Thread 的权限上限是父 Thread 的权限；深度与并行子线程数受宿主配置
  限制，超限以 `THREAD_LIMIT` 拒绝。
- **不搬对话**。首封工作消息不携带父 Agent 的 Session 历史；需要的上下文通过 Blackboard
  引用传递，而不是复制父对话。
- **没有「待验收」状态**。普通工作可以用自然语言结束；需要证据或用户明确要求验收时才
  启用 Eval / Review，状态机不把它作为所有 Thread 的完成门槛。

## 事件面

`spawn` 是基类上的模板方法，提交成功后统一派发只读的 `thread/spawned`（`{ thread }`）。
Provider 只实现 `runSpawn`。观察者失败被吞掉 —— 事件用来观察**已建立的 Thread**，
不用来改写创建结果。
