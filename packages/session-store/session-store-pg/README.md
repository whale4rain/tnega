# `@tnega/session-store-pg`

`ctx.sessionStore` 的 Postgres **Provider**（v2 的 store 角色，见 `docs/plans/v2-server-mvp.md` §3.2–3.3）：每个 Session 一行 `session`，每个事件一行 `session_event`（整条事件存为 `jsonb`，是唯一的来源）。

```ts
await ctx.plugin(sessionStorePg, { url: process.env.DATABASE_URL })
const store = ctx.get('sessionStore')
```

宿主用 `TNEGA_SESSION_STORE=postgres` 加 `DATABASE_URL` 选它（`@tnega/runtime` 的 `stateSpecFromEnv`）；不设时仍是 JSONL。

- **一次追加一个事务。** 锁住 `session` 行，检查租约与 `head_seq`，按 `content_hash`（`canonicalEvent` 的 SHA-256）识别重试，插入事件并移动 `head_seq`，最后 `pg_notify('session_events', '<id>:<head>')`。两个服务端连同一个库也不会交错。
- **租约在行上。** `lease_owner` / `lease_until`，每 5 秒续一次，30 秒没人续可以接管，和本机锁文件的数字一样。冻住后又醒来的旧持有者会被行上的检查挡在外面，而不是靠它自觉。本机上已经退出的进程（包括容器重启后 pid 被复用的情况）留下的租约立刻可以接管，所以服务端被杀后重启能马上接着写同一个 Session。
- **`SessionLog` 直接跑在行上。** `backend(workspace, id)` 给运行中的 Agent 用；本进程里同一个 Session 的多个 `SessionLog` 共用一个租约。有 `ctx.blobs` 时图片照常存为 blob（格式 11）。
- **工作区。** 服务端用工作区 id（`workspace` 表的 uuid）；其余的键（本机文件夹路径）记成本机设备上的 `daemon_path` 工作区，属于一个 `local` 账户。这个设备生来就是吊销状态，不能用来登录。可用 `workspaces` 选项换成别的解析方式。
- **建表。** 挂载时执行一组幂等的 `create table if not exists`，与计划里的 SQL 完全相同，另加 `(daemon_id, path)` 的唯一索引；用计划里的 SQL 建好的库不会被改动。`bootstrap: false` 跳过。
- `jsonb` 不能存 `\u0000`：工具输出里的 NUL 会存成 U+FFFD。

测试：代码层用 PGlite（`test/store.test.ts`，含与 JSONL Provider 同样事件得到同样快照与 `renderToolResult` 文本）；宿主层 `test/postgres.e2e.test.ts` 需要 `TNEGA_TEST_DATABASE_URL` 指向一个真实的 Postgres（按计划 SQL 建好的库、1,000 个事件按序读回、两个服务端只有一个拿到租约、被杀进程的租约立刻接管）。
