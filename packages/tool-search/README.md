# `@tnega/tool-search`

模型可见的 `glob` / `grep` 工具。

## 这是一条缝的哪一个角色

本包是「工作区搜索」能力缝三角色里的 **Consumer**。它只依赖
[`@tnega/search`](../search/README.md)（Service Definition）与 `@tnega/tools`
（注册表），**从不 import 任何具体 Provider** —— 不 import `@tnega/search-ripgrep`，
也不枚举 Provider、不探测可用性。进入这条缝的唯一路径是 `ctx.search.resolve*` 与
`ctx.search.findFiles` / `ctx.search.searchText`。

```
@tnega/search-ripgrep (Service Provider) ─┐
                                          ├─→ @tnega/search
@tnega/tool-search    (本包, Consumer) ──┘
```

换 Provider = 改 composition 层的挂载行，本包与模型看到的工具零改动。

## 分工

- **本包拥有模型可见的一切**：工具名、description、JSON schema、结果形状
  （`glob` 返回 `string[]`，`grep` 返回 `[{ file, line, text }]`）以及
  `ToolDefinition.timeoutMs`。
- 搜索怎么跑、用什么二进制、怎么解析，全部属于 Provider。
- 工作区路径约束（`resolveInside`）留在本包，与 `read_file` / `write_file` /
  `list_dir` 等其它文件工具保持一致；Provider 会再校验一次搜索根是相对路径且不含 `..`。

## 用法

```ts
await root.plugin(tools)
await root.plugin(searchRipgrep, { cwd: workspace })   // Provider，composition 层
await root.plugin(toolSearch, { cwd: workspace })      // Consumer
```

## 测试

`test/` 里的用例把 **fake Provider** 挂在真实 `Context` 上，`glob` / `grep` 的行为断言
完全不变 —— 这是本缝可替换性的机器可验证证明。
