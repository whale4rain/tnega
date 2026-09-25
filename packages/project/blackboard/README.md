# `@tnega/blackboard`

Project 共享持久化能力的 **Service Definition**：拥有 `ctx.blackboard`。

## 这是一条缝的哪一个角色

本包是能力缝三角色里的 **Service Definition**。它是一条**抽象 Cordis `Service`**，
不是 TypeScript `interface` —— 抽象类才能拥有 `ctx.blackboard` 这个键，也才能让
Provider 通过 `extends` 完成注册。

```
@tnega/blackboard-local (Service Provider) ─┐
                                             ├─→ @tnega/blackboard (ctx.blackboard)
@tnega/box-blackboard、@tnega/thread-local ─┘
```

Provider 与 Consumer **互不依赖**；它们只 import 本包。换 Provider 只改 composition
层的挂载，消息通道（Box）、Thread 生命周期和模型可见工具零改动。

## 契约

Blackboard 是 Project 的共享事实层：**有类型的版本记录 + 条件提交**。它不是键值存储。

- **不是任意键值写入**。`FactKind` 是封闭集合，每种 kind 的 `data` 形状由拥有它的缝
  定义（`message` / `delivery` 属于 Box，`agent` / `dependency` 属于 Thread，
  `project` 属于 Project，`memory` / `decision` / `resource` / `artifact` 属于
  `@tnega/tool-blackboard`）。本缝不解释 `data` 的业务含义。
- **不覆盖**。已存在的记录必须带 `expectedVersion`：省略即 `BLACKBOARD_VERSION_REQUIRED`，
  不符即 `BLACKBOARD_CONFLICT` 并把当前记录随错误带回，由写入者重新读取后合并。
  Provider 不做自动合并 —— 设计稿要求「不能最后写入覆盖」。
- **原子批量**。`commitAll` 里任何一条失败即整批不落盘。Box 的信封与它的收件人投递
  记录必须一起出现，否则崩溃恢复会看到没有投递目标的信封。
- **删除是新版本**。`deleted: true` 是一条新版本，旧版本留在 `history` 里；用户纠错
  可追溯，恢复就是再提交一次 `deleted: false`。
- **不存对话**。完整模型历史属于各 Agent 的 Session；本缝只存项目共享事实。

## 事件面

`commit` / `commitAll` 是基类上的模板方法，提交成功后统一派发只读的
`blackboard/commit`（`{ records }`）。Provider 只实现 `runRead` / `runList` /
`runHistory` / `runCommit` / `runCommitAll`，因此任何 Provider 都自动参与该通知，也
不可能绕过它。观察者失败被吞掉：事件用来观察**已提交的事实**，不用来改写提交结果。

```ts
ctx.on('blackboard/commit', event => { /* 刷新投影、唤醒下游 */ })
```

## 三个来源，各有所有者

| 事实 | 唯一来源 |
| --- | --- |
| 某个 Agent 的模型可见历史、工具调用与结果 | 该 Agent 的 Session |
| 项目共享记忆、资料与产物索引、Agent 关系、消息信封 | 本缝（Blackboard） |
| 消息应交给谁、是否已送达 | Box 的规则，状态写在本缝，不另造真源 |
