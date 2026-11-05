# `@tnega/fs-local`

`ctx.fs` 的本机 **Provider**（Service Definition 见 `@tnega/fs`）。

- `fsLocal` 插件注册 `LocalFs`；`LocalWorkspaceFs` 也可以直接 `new`（测试、没有作用域的组合层默认值）。
- 围栏只用 `@tnega/fs-sandbox` 的 `resolveInside`，那是「工作区之内」的唯一定义。
- `writeFileAtomic`（原 `@tnega/tool-fs` 的 `atomic.ts`）：私有 staging 目录 + `rename` / `link` 原子发布，
  见 `docs/adr/0014-atomic-file-writes.md`。
- `canonicalPath`：跟随 symlink 的真名，目标不存在也能算。

由 composition 层挂载（`packages/runtime` 的 `capability:fs`、`packages/host` 的 Workbench 文件路由），
Consumer 从不 import 本包。

```ts
await ctx.plugin(fsLocal)
const files = ctx.fs.workspace(workspace, { allowOutside: () => permission === 'bypass' })
```
