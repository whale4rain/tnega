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

`execution.ts` 定义了可替换的执行边界：

- `ExecutionProvider`：`runShell(request)` / `fetchHttp(request)`
- `localExecutionProvider`：本机实现（`shell` / `http_get` 工具经它执行）
- 换远程沙箱 = 换一个 Provider，Consumer（内置工具）零改动。

DSH 三角色：Consumer 只 import Service Definition，从不 import 具体 Provider。
composition 层（CLI bundle）才 import Provider。

## 内置工具

| 工具 | 说明 | 开关 |
|---|---|---|
| `echo` `now` `calculator` `json` | 纯计算/回显 | 默认 |
| `read_file` `write_file` `list_dir` `glob` `grep` | 工作目录内文件操作，路径沙箱 | 默认 |
| `shell` | 子进程执行 | `--allow-shell` |
| `http_get` | 网络抓取 | `--allow-network` |

文件工具拒绝二进制、限制读写/搜索字节；`calculator` 拒绝非法算术输入。
`path.ts` 的 `resolveInside` 把一切路径限制在 cwd 内。

## 事件

`tools/change`（注册表变更）、`tools/pre-execute`、`tools/execute`、
`tools/post-execute`、`tools/result`（见上）。

## 测试

`packages/tools/test/`：注册/卸载、管线钩子顺序、policy、路径逃逸、字节限制、
内置工具行为。CLI 端到端见 `packages/cli/test/tools-e2e.test.ts`。
