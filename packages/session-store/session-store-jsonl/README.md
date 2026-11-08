# `@tnega/session-store-jsonl`

`ctx.sessionStore` 的本机 **Provider**：每个 Session 一个 JSONL 文件，放在 `~/.tnega` 下按工作区分的目录里（旧的 `<workspace>/.tnega/sessions` 会被导入）。

```ts
await ctx.plugin(sessionStoreJsonl)
const store = ctx.get('sessionStore')
```

- 租约就是 `@tnega/session` 的锁文件：另一个进程写着时 `lease` 抛 `SessionLeaseError`，锁文件 30 秒没刷新就接管；同一进程里由租约表区分 owner，正在写的 `SessionLog` 也算占用。
- `append` 每个文件依次执行：先看 id 是否已存（重试），再比对 `expectedSeq` 与文件末尾的 seq，最后追加并 `fsync`。
- 插件卸载时释放所有租约。

这个包也还导出原来的函数入口（`createSession`、`listSessions`、`readSessionSnapshot` 等），宿主与各功能包会在 P3 的后续改动里改用 `ctx.sessionStore`。
