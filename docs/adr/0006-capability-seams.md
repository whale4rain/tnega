# 能力缝：把可替换能力拆成 Service Definition / Service Provider / Consumer

> 状态：当前
> 取代关系：无
> 当前实现：`packages/search/README.md`、`packages/search-ripgrep/README.md`、`packages/tool-search/README.md`、`packages/execution/README.md`

## 背景

`glob` / `grep` 原本把 ripgrep 焊死在工具实现里：`packages/tools/src/builtins.ts`
直接 import `./ripgrep.js`，由同一个模块承担模型可见的 schema、ripgrep 这个具体机制、
以及经 `ExecutionProvider` 落进程三件事。三者变化速率不同 —— 换一个检索实现（内存内
遍历、远程沙箱、索引检索）不应该改动模型看到的工具名、描述与结果形状。

仓库的 `packages/tools/README.md` 早已写下 DSH 三角色规则，但代码里没有任何一条缝成立：
`ExecutionProvider` 是 TypeScript `interface` 且靠 config 传引用，Consumer 直接 import
具体 Provider。

## 决策

采用 dsh 的能力缝定义：一条缝是**一个可替换能力的完整三角色**，不是其中任一角色。

- **Service Definition** 是抽象 Cordis `Service`（不是 TS `interface`），拥有
  `ctx.<key>` 与词汇类型（Request/Spec/Result）、稳定错误码、能力级默认值。
- **Service Provider** 是实现该抽象类的插件；Provider 不注册模型可见的工具。
- **Consumer** 是模型可见的工具；只 import Service Definition，从不 import 具体
  Provider，也不枚举 Provider 或探测可用性。

依赖方向是三角：Provider → Definition，Consumer → Definition，Provider 与 Consumer
互不依赖。Provider 的挑选属于 composition 层。

本次落地一条缝作为第一个完整实例：

```
@tnega/search-ripgrep (Provider) ─┐
                                  ├─→ @tnega/search  (ctx.search)
@tnega/tool-search    (Consumer) ─┘
```

- `@tnega/search`：`SearchService` 抽象类、`FindFiles*` / `SearchText*` 词汇、
  `SearchError` 与 `SEARCH_*` 错误码、`DEFAULT_SEARCH_*` 能力默认值。
- `@tnega/search-ripgrep`：ripgrep 机制（二进制解析、argv 构造、`--json` 解析）。
- `@tnega/tool-search`：`glob` / `grep` 的 schema、description 与结果形状。

契约要点：`resolve*` 是默认值与上限唯一的落点（`findFiles` / `searchText` 内部不再出现
`?? 默认值`）；pattern 无匹配与命中结果上限是**结果**（后者以 `truncated` 标记），只有
基础设施失败才以 `SearchError` reject。

顺带把 `packages/tools/src/execution.ts` 原样搬成 `@tnega/execution`：搜索 Provider
必须落进程，若让它自带 spawn 就会出现第二条执行边界，Windows 进程树终止那类逻辑会有两份
并必然漂移。该包是**纯库、无 ctx key**，按 dsh 措辞属于 library 而非缝；`@tnega/tools`
继续 re-export 它，公共面不变。

## 后果

- 换 Provider = 改 composition 层的挂载行（`packages/cli/src/commands.ts`、
  `packages/cli/src/server.ts`、`packages/eval/src/codingRuntime.ts`），
  `@tnega/tool-search` 与模型看到的工具零改动。
- `builtinTools` 不再注册 `glob` / `grep`；`DEFAULT_BUILTIN_TOOL_NAMES` 与
  `BuiltinToolsConfig` 相应收窄（`ripgrepPath` / `respectGitignore` /
  `searchExcludes` / `searchTimeoutMs` / `searchOutputMaxBytes` 迁到 Provider 配置）。
  三个 composition 根在 `builtinTools !== false` 时同时挂载 Provider 与 Consumer，
  保持 `builtinTools: false` 的既有语义。
- 新增发布子路径 `execution` / `search` / `search-ripgrep` / `tool-search`，需同步
  `scripts/build.mjs`、根 `package.json` 的 `exports` 与 `test/publish.test.ts`。
- 一次组合只挂一个 Provider：同作用域注册第二个同名服务由 core 直接抛出，是组合期的护栏。

**有意识的偏离**：dsh 明确反对提前拆分（只有一个可设想 Provider 的能力保持单包），
而且它自己并没有把 search 做成缝 —— `dsh-tool-fs-search` 刻意不 inject `fs`，ripgrep
留在 Consumer 内部，被缝化的是它脚下的 `ctx.subprocess`。本次先拆 search 的依据是第二个
Provider 已经具体可设想（本仓库上一版实现过的内存内 JS 遍历、远程沙箱内检索、索引检索）。
如果这个前提不成立，正确做法是把进程边界缝化，而不是本次这一刀。

## 验证

- `packages/search-ripgrep/test/ripgrep.test.ts`：argv 构造、`--json` 解析、
  退出码分类、二进制解析、`resolve*` 的默认值落点与路径校验。
- `packages/tool-search/test/tool-search.test.ts`：把 fake Provider 与真
  `searchRipgrep` 分别挂在真实 `Context` 上，同一组契约断言原样通过 —— 换 Provider 时
  Consumer 零改动的机器可验证证明。
- `pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm build` / `pnpm test:package`。
- 端到端：`pnpm tnega` 在真实工作区执行 `glob packages/*/README.md`，应约 200ms 返回
  10 条；`rg` 不在 `PATH` 时给出 `SearchError`（`SEARCH_FAILED`）而不是挂起。
