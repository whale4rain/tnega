# `@tnega/spill-local`

`@tnega/spill` 能力的 **Service Provider**：把溢出文本落到本地文件系统。

## 这是一条缝的哪一个角色

本包是能力缝三角色里的 **Service Provider**。它子类化 `SpillStore` 并以插件形式挂载，
注册为 `ctx.spillStore`；一个作用域只允许一个后端，第二个会直接失败。本包不注册任何
模型可见的工具，也不知道谁会用它。

## 存储布局

```
<cwd>/.tnega/spill/[<sessionId>/]<toolName>-<callId>-<suggestedName>
```

调用 id 进文件名，同一工具被反复调用时各自留档而不是互相覆盖。`suggestedName` 只保留
字母数字与 `._-`、去掉开头的点、截断长度 —— 它是提示，不是路径。给了 `owner.sessionId`
就多一层目录，便于按会话清理。

## 定位符

存储根位于 `cwd` 之内时，`locator` 是**相对 `cwd` 的路径**（`.tnega/spill/...`），
这样模型用它调 `read_file` 时正好落在工具的沙箱基准内；存储根在 `cwd` 之外时退回绝对
路径，因为相对路径无法打开它。

`retrievalHint` 只描述「这个路径怎么用」（`read_file` 加 `offset`/`limit`、或直接 grep），
与组合里挂了哪些工具无关。消费者把两者一起渲染，不解析 `locator`。

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `cwd` | `process.cwd()` | 工作区根，决定定位符是否相对化 |
| `root` | `<cwd>/.tnega/spill` | 存储根目录 |

## 失败

`mkdir` 或 `writeFile` 失败（权限、磁盘满、`root` 位置上是个文件等）以
`SpillError(SPILL_FAILED)` 抛出，`cause` 指向原始错误。调用方决定怎么降级；本包不吞错。

## 文件

| 文件 | 角色 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 插件入口：`LocalSpillStore`、文件名净化、定位符选择 |
