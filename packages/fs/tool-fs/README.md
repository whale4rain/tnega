# `@tnega/tool-fs`

文件域的模型可见工具：`read_file`、`write_file`、`edit_file`、`list_dir`。

- **读**：按行分页（`offset` / `limit`，默认并上限 2000 行），单次结果最多 50 KiB
  （`read_file` 不经 spill，这是唯一的上限；模型传的 `maxBytes` 只能更小）。整页放得下时长行原样返回；放不下时长行
  截到 `maxLineChars`，结果里的 `note` 告诉模型用 `offset=N, limit=1` 单独读那一行；
  单独一行仍超过上限时也被截断，`note` 指向 shell。
- **写 / 编辑**：私有 staging 目录 + 原子发布（见 `docs/adr/0014-atomic-file-writes.md`），
  保留权限位，symlink 写穿（跟随后的路径再过一次围栏）。`edit_file` 要求 `old_string` 唯一命中（或 `replace_all`），
  多处编辑不得重叠，全部成功或一个都不改。
- **读后写守卫** `fsGuard`：`off` / `warn`（默认）/ `enforce`。观测记录默认是进程级
  的 `sharedObservations`，重建的运行时仍认得读过的文件；可注入独立的 `ObservationStore`。
- **路径**：一律经 `@tnega/tools` 的 `resolveWorkspacePath` / `resolveInside`（`@tnega/fs-sandbox` 的唯一实现）
  围在工作区内，除非组合层给了 `allowOutsideWorkspace`（`bypass` 权限）。

`glob` / `grep` 在同域的 `@tnega/tool-search`，它是搜索缝的 Consumer。

```ts
await ctx.plugin(toolFs, { cwd: workspace, fsGuard: 'warn' })
```
