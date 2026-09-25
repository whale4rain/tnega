# `@tnega/project`

Project 身份与目录的 **Service Definition**：拥有 `ctx.projects`。

## 这是一条缝的哪一个角色

本包是能力缝三角色里的 **Service Definition**。它是一条**抽象 Cordis `Service`**，
不是 TypeScript `interface` —— 抽象类才能拥有 `ctx.projects` 这个键，也才能让
Provider 通过 `extends` 完成注册。

```
@tnega/project-local (Service Provider) ──→ @tnega/project (ctx.projects)
@tnega/cli 的 Project Host (Consumer)   ──┘
```

## 契约

- **创建只需要名称**。除了名称（可选加一句初始目标），没有必填项；仓库、资料、模型和
  预算都是之后逐步补上的设置，不是创建的前置条件。
- **身份不是 Workspace**。`Workspace`（见 `CONTEXT.md`）仍然是「一个绝对路径目录」；
  Project 有自己的 ID、共享事实目录和 Agent 树，不被 Workspace 替代，也不与它等价。
- **这里不装运行时**。本缝只管身份与目录，一个 Project 作用域里挂哪些 Provider 属于
  组合层（CLI 的 Project Host）。
- **归档可恢复，删除永久生效**。归档是 Project 身份上的标记；永久删除由 Provider 同时移除身份和数据目录。

## `coordinatorId` 为什么在创建时就定下来

主对话是用户与协调 Agent 的对话，而协调 Agent 也是一个 Thread。`coordinatorId` 在创建
Project 时就铸定，Thread 缝在第一次打开时按这个 ID 建立它的 Session 文件夹；因此重新
打开 Project 永远回到同一个 Session，而不是新建一个「看起来一样」的对话。
