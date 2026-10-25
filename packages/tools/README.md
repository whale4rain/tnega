# `@tnega/tools`

工具注册表与执行管线。默认工具集开箱即用，高权限能力显式开关。

## 工具执行管线（三层 waterfall + policy）

一次 `tools.execute(name, input)` 走过：

```
tools/pre-execute  [waterfall]  校验 / 授权 / 策略，可短路拒绝
tools/execute      [waterfall]  真正执行（最内层调 tool.execute）
tools/post-execute [waterfall]  结果截断 / 规范化
tools/result       [parallel]   事后通知（审计、UI）
```

- 单工具策略 `ToolPolicy`：`validator`（schema 校验）/ `authorizer`（授权）/
  `truncator`（截断），逐级合并到全局 `ToolsConfig`。
- `ToolsService.guard()`：单调 guard，pre-execute 之后判一次，denied 后不可再放行。
- 执行是**先 tool/call 落日志，再执行，最后 tool/result 落日志**——意图与结果是事实，
  中间 policy 过程不是（落在 agent 的 durable 事件上）。

## 能力缝

本包不再定义任何能力缝。执行边界与工作区搜索都已经是独立的能力缝，见
`docs/adr/0006-capability-seams.md`：

- 执行边界（纯库，无 ctx key，尚不是缝）：`@tnega/execution`。本包 re-export 它，
  所以 `ExecutionProvider` / `localExecutionProvider` 仍从 `@tnega/tools` 可用。
- 工作区搜索（完整三角色）：`@tnega/search`（Service Definition，`ctx.search`）/
  `@tnega/search-ripgrep`（Service Provider）/ `@tnega/tool-search`（Consumer，
  模型可见的 `glob` / `grep`）。本包不再注册这两个工具。

三角色的依赖方向是：Provider → Definition，Consumer → Definition，Provider 与
Consumer 互不依赖；Provider 的挑选属于 composition 层。

## 本包不注册模型可见工具

工具按能力域放在各自的包里：

| 工具 | 包 |
|---|---|
| `read_file` `write_file` `edit_file` `list_dir` | `@tnega/tool-fs`（`packages/fs/tool-fs`） |
| `glob` `grep` | `@tnega/tool-search`（`packages/fs/tool-search`） |
| `shell` | `@tnega/tool-shell`（`packages/shell/tool-shell`），需显式 `allowShell` |
| `http_get` | `@tnega/tool-web-fetch`（`packages/web/tool-web-fetch`），需显式 `allowNetwork` |

`echo`、`calculator`、`json` 已删除，`now` 归 Project 域。组合层（`@tnega/runtime` 的
`builtinTools`）决定一个作用域挂哪些。本包只留它们共用的词汇：入参读取
（`record` / `stringField` …）、`ToolInputError`、`resolveInside`（`@tnega/fs-sandbox`
的转发，路径围栏全仓库只有那一份实现）、按路径锁 `withPathLock`、提权声明
（`ESCALATE_PROPERTIES` / `escalated`）与后台进程交接（`ADOPT_BACKGROUND_PROCESS`）。

`tools.execute` 为声明了 `ToolDefinition.timeoutMs` 的工具装上 deadline：它把
组合后的 signal 交给工具，只有自己的计时器真的触发时才把结果替换成
`ToolTimeoutError`；调用方的 signal 先中断时保留工具自己的 abort 结果。没有声明
预算的工具不受影响。

## 事件

工具可以声明 `interruption`（默认 `fail`）：`retry` 表示中断后可用新调用重试，
`confirm` 表示先与用户确认既有副作用。此指导持久化到 Session，但不会自动重放工具。

格式不合 schema 的调用在执行前以 `ToolInputError` 拒绝，不做类型强转或静默宽容解析。
错误包含字段问题与期望参数形状；Agent 将失败结果持久化并交回模型，下一 step 可纠正。
校验包括嵌套对象/数组、enum、禁止额外字段及声明的数值、字符串长度和数组长度边界。

`tools/change`（注册表变更）、`tools/pre-execute`、`tools/execute`、
`tools/post-execute`、`tools/result`（见上）。

## 测试

`packages/tools/test/`：注册/卸载、管线钩子顺序、policy、错误文案。各工具的行为测试在
各自的包里；默认工具集的组合见 `packages/runtime/test/builtins.test.ts`。CLI 端到端见 `packages/cli/test/tools-e2e.test.ts`。
