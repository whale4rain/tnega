# `@tnega/tool-spill`

把过大的工具结果挡在模型上下文之外、完整记录留给溢出存储的 **Consumer**。

## 这是一条缝的哪一个角色

本包是能力缝三角色里的 **Consumer**。它 inject `tools` 与 `spillStore`，在
`tools/post-execute` 上挂一个监听器，只 import `@tnega/spill` 的契约 —— 不 import 任何
后端，不枚举后端，也不探测可用性。挂载：

```ts
await root.plugin(spillLocal, { cwd })      // Provider
await root.plugin(toolSpill, { maxInlineBytes: 50_000 })  // Consumer
```

必须同时挂一个 `ctx.spillStore` 后端；只挂 Consumer 会在加载期失败，而不是在第一次遇到
大结果时才发现没地方存。

## 行为

成功的工具结果在进入模型上下文之前按 `maxInlineBytes` 判断。超出时：

1. 整份文本（`renderToolResult` 渲染出的、模型本来会看到的那份）写进 `ctx.spillStore`；
2. 结果被换成「头尾预览 + 省略说明」：

```
<head 预览>
…
<tail 预览>

(Omitted 14129 bytes. Full formatted result stored at: .tnega/spill/shell-call_1-shell.txt. Read it with the read_file tool (raise maxBytes or use offset/limit for a specific window), or grep this path to search inside it.)
```

预览从两端取，按剩余空间**等比**收缩 —— 不让头部吃掉全部余量：结果的结尾通常才是模型
最需要看的地方。切点落在 UTF-8 码点中间时丢掉那个不完整字符，绝不吐出替换字符。说明里
的省略字节数是精确值（头尾实际保留多少，剩下的就是多少）。

替换后的总长**不超过 `maxInlineBytes`**；拼不进去（上限太小、定位符太长）就保留原文，
已经在存储里的那份不受影响。

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `maxInlineBytes` | `50_000` | 单个结果的模型可见上限，UTF-8 字节；负数或非有限值在加载期抛 `TypeError` |
| `headBytes` | `12_000` | 预览保留的头部字节数 |
| `tailBytes` | `4_000` | 预览保留的尾部字节数 |
| `skip` | `['read_file']` | 不参与溢出的工具名 |

`read_file` 默认排除：它本身已经是「按需读一段」的工具，把它溢出会让模型为了读回刚读
的东西再去读一个文件，绕成环。

## 尽力而为

落盘失败只记一条 `ctx.logger.warn` 并保留原文。溢出失败**不能**把一个成功的工具调用变成
失败的，也**不能**让内容凭空消失。

## 与日志、重放的关系

被替换的是权威结果本身（`ToolResult.output`），不是它的一份模型可见副本：会话日志、
`deriveMessages()` 重放、前端读到的都是预览。完整原文只存在于溢出文件里，定位符就在
说明中。这样重放渲染出的文本与实时请求完全一致，不需要改动持久化格式。取舍与理由见
`docs/adr/0007`。

## 文件

| 文件 | 角色 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 校验、`tools/post-execute` 监听器、预览与省略说明的合成 |

## 测试

[`test/tool-spill.test.ts`](test/tool-spill.test.ts) 挂的是本包**从未听说过的 fake
后端** —— Consumer 只认识 `ctx.spillStore`，一旦改成依赖某个具体 Provider，这些用例就
不再编译。
