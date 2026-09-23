# `@tnega/spill`

把过大的文本存到别处、换回一个可检索定位符的能力的 **Service Definition**：拥有
`ctx.spillStore`。

## 这是一条缝的哪一个角色

本包是能力缝三角色里的 **Service Definition**。它是一条**抽象 Cordis `Service`**，
不是 TypeScript `interface` —— 抽象类才能拥有 `ctx.spillStore` 这个键，也才能让
Provider 通过 `extends` 完成注册。

```
@tnega/spill-local (Service Provider) ─┐
                                       ├─→ @tnega/spill
@tnega/tool-spill  (Consumer)        ──┘
```

Provider 与 Consumer **互不依赖**；Consumer 只 import 本包，从不 import 任何 Provider。
换后端（远程对象存储、数据库、沙箱内路径）只改 composition 层的挂载。

## 契约

- **只有一种方法**：`saveText(request) → SpillRef`。本缝不做保留策略、不做结果替换、
  不提供读取或检索 API —— 何时溢出由 Consumer 决定，怎么存由 Provider 决定。
- **拒绝，不静默降级**。存储失败就以 `SpillError`（`SPILL_FAILED`）reject：调用方自己
  决定是保留原文还是失败，缝不替它做决定。请求本身非法是 `SPILL_INVALID`。
- **定位符不透明**。消费者只把它和 `retrievalHint` 一起渲染给模型，不解析、不拼接、
  不假设它是路径 —— 本地后端返回的是路径，别的后端可以是 URI 或 key。
- **建议名只是建议**。`suggestedName` 由后端压成一个安全的路径片段，调用方不得依赖它
  决定读写位置。
- 一次组合只挂一个 Provider。同一作用域注册第二个同名服务由 core 直接抛出，是组合期的
  护栏。

## 词汇

| 类型 | 用途 |
| --- | --- |
| `SaveTextSpill` | 一次落盘请求：`source` / `suggestedName` / `content` / 可选 `owner` |
| `SpillSource` | 产物来源；目前是 `{ kind: 'tool', toolName, callId, label? }` |
| `SpillOwner` | 归属（`{ sessionId }`），后端据此分组，便于按生命周期清理 |
| `SpillRef` | 落盘结果：`locator` / `bytes` / `retrievalHint` |

`owner` 是可选的：一个组合未必知道当前会话的稳定标识，缺省时后端落在同一个平铺目录里。

## 文件

| 文件 | 角色 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 插件契约：`SpillStore` 抽象类、`saveText`、词汇与 `SpillError` |

本包不注册任何服务、不发布不变量伴随包：除 `saveText` 的输入输出外，它没有自己的事件
序列或可变数据关系。
