# `@tnega/tool-shell`

模型可见的 `shell`。高权限：组合层只在显式 `allowShell` 时挂载。

- 命令跑在注入的 `ExecutionProvider` 上 —— 实际是 `execution-sandbox` 的沙箱装饰器，
  所以本包不知道沙箱的存在；`escalate` 需要审批，批准后才 `unsandboxed`。
- `runInBackground` 由本包声明、由 `@tnega/tool-jobs` 接管：jobs 插件在守卫决定之后通过
  `ADOPT_BACKGROUND_PROCESS` 把启动的进程收走，一条命令只过一次审批。两个包互不依赖，
  交接词汇在 `@tnega/tools`，进程登记表 `ProcessRegistry` 在 `@tnega/execution`。

```ts
await ctx.plugin(toolShell, { cwd: workspace, execution, processes })
```
