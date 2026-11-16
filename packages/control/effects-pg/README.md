# `@tnega/effects-pg`

`ctx.effects` 的 Postgres **Provider**。两张表：`effect`（`kind` + `key` 唯一，`due_at`、`attempts`、`last_error`）与 `schedule`（主键 `kind` + `key`，`spec`、`next_run_at`）；计划里的 `(project_id, routine_id)` 推广成 `(kind, key)`，Routine 是其中一种。

- 循环默认每 2 秒一轮，`enqueue` / `schedule` 到期时立刻补一轮。一轮先认领到期的 schedule（`for update skip locked`，同一事务里插 effect、推进 `next_run_at`），再取到期且本进程有处理器的 effect。
- 取走的 effect 把 `due_at` 推到租期之后（默认 5 分钟）并 `attempts + 1`，提交后再运行：别的服务器在租期内不会再取；处理器中途崩溃，租期过后重跑。只有取走它的那次尝试可以删除或改写它（按 `attempts` 判断）。
- `intervalMs: 0` 不起循环（测试里手动 `tick()`）；`now` 可注入时钟。
