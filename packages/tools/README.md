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

## 内置工具

| 工具 | 说明 | 开关 |
|---|---|---|
| `echo` `now` `calculator` `json` | 纯计算/回显 | 默认 |
| `read_file` `write_file` `list_dir` | 工作目录内文件操作，路径沙箱 | 默认 |
| `shell` | 子进程执行 | `--allow-shell` |
| `http_get` | 网络抓取 | `--allow-network` |

`glob` / `grep` 由 `@tnega/tool-search` 注册，见上面的能力缝一节。

文件工具拒绝二进制、限制读写字节；`calculator` 拒绝非法算术输入。
`path.ts` 的 `resolveInside` 把一切路径限制在 cwd 内；`list_dir --recursive`
会剪掉 `DEFAULT_SEARCH_EXCLUDES` 里的噪声目录。

`shell` / `http_get` 的进程与网络执行走 `@tnega/execution` 的 `runShell` /
`runProcess` / `fetchHttp`。

`tools.execute` 为声明了 `ToolDefinition.timeoutMs` 的工具装上 deadline：它把
组合后的 signal 交给工具，只有自己的计时器真的触发时才把结果替换成
`ToolTimeoutError`；调用方的 signal 先中断时保留工具自己的 abort 结果。没有声明
预算的工具不受影响。

## 事件

`tools/change`（注册表变更）、`tools/pre-execute`、`tools/execute`、
`tools/post-execute`、`tools/result`（见上）。

## 测试

`packages/tools/test/`：注册/卸载、管线钩子顺序、policy、路径逃逸、字节限制、
内置工具行为。CLI 端到端见 `packages/cli/test/tools-e2e.test.ts`。
