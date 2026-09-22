# `@tnega/search`

工作区搜索能力（文件发现 + 内容检索）的 **Service Definition**：拥有 `ctx.search`。

## 这是一条缝的哪一个角色

本包是能力缝三角色里的 **Service Definition**。它是一条**抽象 Cordis `Service`**，
不是 TypeScript `interface` —— 抽象类才能拥有 `ctx.search` 这个键，也才能让 Provider
通过 `extends` 完成注册。

```
@tnega/search-ripgrep (Service Provider) ─┐
                                          ├─→ @tnega/search
@tnega/tool-search    (Consumer)        ──┘
```

Provider 与 Consumer **互不依赖**；Consumer 只 import 本包，从不 import 任何 Provider。
换 Provider 只改 composition 层的挂载，`@tnega/tool-search` 与模型看到的 `glob` /
`grep` 零改动。

## 契约

- `resolveFindFiles` / `resolveSearchText` 把请求解析成完全显式的 spec：默认值、上限、
  排除目录、`.gitignore` 策略都在这一步落定。`findFiles` / `searchText` 内部不得再出现
  `?? 默认值`。
- **结果与拒绝分开**：pattern 无匹配、命中结果上限都是正常结果（后者以 `truncated`
  标记）；只有基础设施失败才以 `SearchError` reject，错误码是
  `SEARCH_INVALID_PATTERN` / `SEARCH_INVALID_PATH` / `SEARCH_FAILED` /
  `SEARCH_OUTPUT_OVERFLOW` / `SEARCH_ABORTED`。
- 一次组合只挂一个 Provider。同一作用域注册第二个同名服务会直接失败（core 的
  `ctx.provide` 语义），这是组合期的护栏。

## 能力级默认值放在这里

`DEFAULT_SEARCH_EXCLUDES` / `DEFAULT_SEARCH_TIMEOUT_MS` /
`DEFAULT_SEARCH_OUTPUT_MAX_BYTES` / `DEFAULT_SEARCH_MAX_RESULTS` 由本包导出而不是由
Provider 导出：它们命名的是能力默认值，不是某个实现的选择。Provider 的 `Config` 字段
以它们为默认。

## 词汇

`FindFilesRequest` / `SearchTextRequest` → `FindFilesSpec` / `SearchTextSpec` →
`FindFilesResult` / `SearchTextResult`，加上 `SearchMatch` 与 `SearchError`。
`src/types.ts` 只有类型与常量，没有运行时 I/O。
