# `@tnega/fs`

文件系统缝的 **Service Definition**：拥有 `ctx.fs`。v2 计划 P1（`docs/plans/v2-package-changes.md`）。

```
@tnega/fs-local (Provider：node:fs) ─┐
                                     ├─→ @tnega/fs
@tnega/tool-fs、@tnega/tool-send-file、
@tnega/workspace-files (Consumer) ──┘
```

工作区的文件访问都经过这里，这样文件可以在另一台机器上：本机 Provider 用 `node:fs`，
远端 Provider（P4 的 `fs-remote`）把同样的调用发给 daemon。Consumer 只 import 本包。

## 契约

- `ctx.fs.workspace(root, { allowOutside })` 打开一个工作区，得到 `WorkspaceFs`。很便宜，
  宿主路由可以每个请求开一个。
- `WorkspaceFs` 的每个方法都接受工作区相对路径或绝对路径，**每次调用都由 Provider 过围栏**：
  `..`、绝对路径、symlink 逃出工作区一律拒绝（`PathSandboxError`），除非 `allowOutside`
  （`bypass` 权限）为真；`allowOutside` 每次调用时读取。
- `resolve(path)` 返回跟随 symlink 之后的真名（目标不存在也能算），再过一次围栏；文件工具的
  锁、读记录和写入都用这个名字。写入（`writeFile`）自己也先 `resolve`，所以 symlink 写穿但不会被带出工作区。
- `stat` 跟随 symlink，路径不存在时返回 `undefined`；`list` 返回条目自身的类型（symlink 仍是 `symlink`）。
- `writeFile` 的 `mode`：`replace`（默认，原子替换并保留权限位）、`create`（原子且不覆盖，
  已存在时抛 `FsError` `FS_EXISTS`）、`append`。父目录按需创建。目标被别的程序占用而替换放弃时抛 `FS_BUSY`，旧内容不变。
- 其它失败保留平台自己的错误和 `code`（`ENOENT`、`EACCES` …）。
- 一个作用域只挂一个 Provider；同一作用域第二个会在挂载时失败。Project 线程用 `isolate('fs')` 拿到自己的作用域。
