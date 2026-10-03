# `@tnega/subagent-local`

本地子代理 Provider，负责启动、恢复和读取 durable Session 与父代理报告。

`LocalSubagentConfig.cwd` 指定 Workspace；默认历史与产物保存在
`<cwd>/.tnega/subagents/<id>/`。组合层可传入 `storageRoot`，改为
`<storageRoot>/<id>/session.jsonl` 与 `<storageRoot>/<id>/artifacts/`。
此选项不改变 Workspace 或工具权限，也不自动迁移旧历史。

离线读取采用相同目录选项：

```ts
await listStoredSubagents(workspace, parentId, 'children', undefined, storageRoot)
await readSubagentEvents(workspace, childId, storageRoot)
```

省略 `storageRoot` 时继续读取 Workspace 下的默认目录。恢复服务时传入相同
`storageRoot`，即可继续使用已有子代理的 Session。
