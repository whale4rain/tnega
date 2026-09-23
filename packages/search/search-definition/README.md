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
  排除目录、`.gitignore` 策略都在这一步落定。`runFindFiles` / `runSearchText` 内部不得
  再出现 `?? 默认值`。
- **结果与拒绝分开**：pattern 无匹配、命中结果上限都是正常结果（后者以 `truncated`
  标记）；只有基础设施失败才以 `SearchError` reject，错误码是
  `SEARCH_INVALID_PATTERN` / `SEARCH_INVALID_PATH` / `SEARCH_FAILED` /
  `SEARCH_OUTPUT_OVERFLOW` / `SEARCH_ABORTED`。
- 一次组合只挂一个 Provider。同一作用域注册第二个同名服务会直接失败（core 的
  `ctx.provide` 语义），这是组合期的护栏。
- **事件面属于本包**：`findFiles` / `searchText` 是基类上的模板方法，负责派发事件并调用
  抽象的 `runFindFiles` / `runSearchText`。Provider 只实现机制，因此自动参与全部事件，
  既不需要知道事件名，也无法绕过事件。

## 事件

搜索的操作级扩展点由本包拥有，与 `@tnega/agent` 的 `agent/*`、`@tnega/tools` 的
`tools/*` 同构（事件名是字符串）。

| 事件 | 派发方式 | 作用 |
|---|---|---|
| `search/pre-search` | `waterfallAsync` | spec 已解析、尚未执行。可改写 spec（收紧 excludes、强制 `.gitignore`、收窄 pattern 或时间预算） |
| `search/post-search` | `waterfallAsync` | 已有结果、尚未交给调用方。可改写结果（脱敏、过滤、重排） |
| `search/result` | `parallel` | 正常结束（`truncated` 也算）后的只读通知：审计、指标、UI |
| `search/error` | `parallel` | 基础设施失败后的只读通知；`error` 为 `SearchError` 时保留 `code` |

负载类型是 `SearchPreEvent` / `SearchPostEvent` / `SearchResultEvent` /
`SearchErrorEvent`，都按 `op: 'findFiles' | 'searchText'` 判别。

### 改写点：就地改写 + 无参 `next()`

两个 waterfall 事件遵循 core 的约定（与 `agent/pre-step`、`tools/pre-execute` 完全
一致）：**监听器就地改写负载，然后调用无参的 `next()`**。

```ts
ctx.on('search/pre-search', (event, next) => {
  event.spec = { ...event.spec, maxResults: 10 }
  return next()
})
```

注意 `next()` **不接受参数** —— waterfall 的下一层始终拿到同一个负载对象，所以改写必须
落在负载上；把新对象传给 `next(...)` 不会有任何效果。

两条硬边界：

- 不调用 `next()`（即返回 undefined）表示**拒绝这一步**：搜索以
  `SearchError`（`SEARCH_FAILED`）失败，语义与 `tools/pre-execute` 相同。改写后的事件 /
  结果形状非法同样以 `SEARCH_FAILED` 拒绝 —— 绝不静默跳过，也绝不把半截结果交给模型。
- `search/result` 与 `search/error` 是**只读观察**：监听器失败会被吞掉。模型看到的结果
  与稳定的 `SEARCH_*` 错误码不因观察者而改变。

事件监听器随注册它的 fiber 卸载自动移除（`ctx.on` 即 effect）。`search/result` 的
`spec` 是实际执行的那份，即 `search/pre-search` 改写之后的 spec。

## 能力级默认值放在这里

`DEFAULT_SEARCH_EXCLUDES` / `DEFAULT_SEARCH_TIMEOUT_MS` /
`DEFAULT_SEARCH_OUTPUT_MAX_BYTES` / `DEFAULT_SEARCH_MAX_RESULTS` 由本包导出而不是由
Provider 导出：它们命名的是能力默认值，不是某个实现的选择。Provider 的 `Config` 字段
以它们为默认。

## 词汇

`FindFilesRequest` / `SearchTextRequest` → `FindFilesSpec` / `SearchTextSpec` →
`FindFilesResult` / `SearchTextResult`，加上 `SearchMatch` 与 `SearchError`。
`src/types.ts` 只有类型与常量，没有运行时 I/O。事件词汇（`SearchOperation` 与四个负载
类型）也在 `src/types.ts`，派发与形状校验在 `src/events.ts`。

## 测试

`test/events.test.ts`：用只回答固定结果的 stub Provider 验证事件面本身 —— pre 改写、
post 改写、非法改写被拒、不调用 `next()` 被拒、`search/result` / `search/error` 的负载
与只读语义、监听器随 fiber 卸载。Provider 机制由
`packages/search/search-ripgrep/test/ripgrep.test.ts` 覆盖，Consumer 行为与「换 Provider 零
改动」的不变量由 `packages/search/tool-search/test/tool-search.test.ts` 覆盖。
