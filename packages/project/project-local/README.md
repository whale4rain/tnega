# `@tnega/project-local`

`ctx.projects` 的本地 Provider：身份条目存在 Blackboard，磁盘目录按 ID 建立。

## 落盘形状

```
<root>/<projectId>/          # root 约定为 <workspace>/.tnega/projects
                             # blackboard/、agents/、artifacts/ 由各自的 Provider 惰性创建
```

身份是同一个 Blackboard 里的 `project` kind 记录，`data` 只有
`{ name, coordinatorId, goal?, repo? }` —— `id` 由记录键提供，`createdAt` / `updatedAt`
由缝的版本记录提供，不在 data 里重复一份。

## 取舍

- **身份只有一个真源**。`project` 记录是唯一权威；Provider 不另外维护
  `projects.json` 之类的索引文件，因此不存在两份列表需要同步。
- **只建目录，不预建子目录**。一个还没用过的 Project 不该在磁盘上留下一堆空目录。
- **并发修改走条件提交**。`update` 先读当前版本再提交；期间被改过就以
  `ProjectError`（`PROJECT_FAILED`）拒绝，由调用者重新读取后重试，而不是覆盖。
- **需要同一作用域里有 Blackboard**。Provider 通过 `inject: ['blackboard']` 声明这一点，
  由组合层挑选具体实现：本机场景是 `@tnega/blackboard-local`，挂载位置决定这份目录
  索引覆盖哪些 Project。
