# 工具输出溢出：把过长的工具结果请出上下文，完整记录留给文件

> 状态：当前
> 取代关系：无
> 当前实现：`packages/spill/spill/README.md`、`packages/spill/spill-local/README.md`、`packages/spill/tool-spill/README.md`

## 背景

工具调用是长上下文的主要来源：一次 `shell` 的 stdout、一次 `grep` 的命中列表，动辄几万
字节，而它们里的绝大多数内容对当前这一步毫无用处。上下文被塞满之后，唯一的下场是触发
压缩 —— 而压缩是有损的、要额外一次模型调用的。

`docs/adr/0004`（会话压缩）解决的是「历史已经满了怎么办」；本决策解决的是它前面一步
「别让一次工具调用就把它塞满」。

同时，前端把 `tool/result` 的 `output` 原样 `JSON.stringify` 进一个 `<pre>`：一次返回
几 MB 的工具调用足以让会话页面卡死。

## 决策

新增第二条能力缝，角色划分沿用 `docs/adr/0006`：

```
@tnega/spill-local (Provider) ─┐
                               ├─→ @tnega/spill  (ctx.spillStore)
@tnega/tool-spill  (Consumer) ─┘
```

- `@tnega/spill`：`SpillStore` 抽象类、`saveText(request) → SpillRef`（`locator` /
  `bytes` / `retrievalHint`）、`SpillError`、`SpillSource` / `SpillOwner` 词汇。
  **只有这一个方法**：不做保留策略、不做结果替换、不提供读取或检索 API。
- `@tnega/spill-local`：本地文件系统后端，落盘到 `<cwd>/.tnega/spill/`。
- `@tnega/tool-spill`：`tools/post-execute` 监听器 + `maxInlineBytes` 策略。

行为：成功的工具结果在进入模型上下文之前按 `maxInlineBytes`（默认 50 000 字节）判断；
超出时整份文本先写进溢出存储，再把结果换成「头尾预览 + 省略说明」，说明里带上定位符与
取回指引。预览从头和尾两端取（默认 12 000 / 4 000 字节，按剩余空间等比收缩），中间被省
掉的部分不多不少地报出字节数。工具在 `skip` 列表里的（默认 `read_file`）不参与，避免
「读文件 → 溢出 → 再读回自己」的环。

### 与 dsh 的两处有意识偏离

1. **被替换的是权威结果本身，不是它的一份模型可见副本。** dsh 的 `spill-policy` 明确
   只改「模型看到的那一份」，保留程序拿到的规范结果。tnega 里两者是同一个对象：模型看
   到的文本由 `renderToolResult` 从 `ToolResult.output` 渲染，会话日志、重放、前端读的
   也是它。要让「模型看到截断版、日志保留完整版」并存，就得在持久化格式里新增一个模型
   可见副本字段，并让重放、token 估算、前端三处都认它。当前选择是不引入这个字段：权威
   结果就是预览，完整记录在溢出文件里 —— 这也正是需求的原话（「多的截断，但是完整记录
   持久化到文件里」）。代价是日志里不再有完整原文，判断依据写在「后果」一节。
2. **Consumer 是 `tools/post-execute` 监听器，而不是一个独立的策略包。** dsh 的
   `spill-policy` 只看得到已经格式化好的文本；tnega 的工具返回结构化结果，模型可见的
   文本在工具管线之后才由 `renderToolResult` 渲染，所以策略必须挂在管线里、在渲染之前
   动手。为此把渲染规则收敛成 `@tnega/session` 的 `renderToolResult` 一个函数，会话折叠、
   token 估算、Agent 组装请求、本策略四处共用，杜绝「量的是 A、发的是 B」。

### 尽力而为

落盘失败（权限、磁盘、后端不可用）只记一条 warning 并保留原文：溢出失败不能把一个成功
的工具调用变成失败的，也不能让内容凭空消失。拼不进上限时（上限太小、定位符太长）同样
保留原文 —— 已经在存储里的那份不会因此消失。

## 后果

- **模型上下文**：单个工具结果最多占 `maxInlineBytes`；超出的部分变成一行定位符。模型
  可以按指引 `read_file` 或 `grep` 那个路径读回。
- **会话日志与前端**：`tool/result` 的 `output` 记录的是预览而不是完整原文。完整原文只
  存在于 `<cwd>/.tnega/spill/` 下的文件里。这是本决策最主要的代价，换的是不需要改动持久
  化格式与重放校验。
- **重放**：因为权威结果本身就是预览，`deriveMessages()` 与实时请求渲染出完全相同的文本，
  `_assertReplayable` 不受影响。
- **前端**：卡片把溢出说明从正文里提出来单独渲染（`.tnega/spill/...` 定位符高亮），并把
  输出渲染长度封顶（`MAX_RENDERED_CHARS = 4 000`，其余一次点击展开）。两道防线：`tool-spill`
  挡住的是「模型看到多少」，前端封顶挡住的是「页面渲染多少」—— 后者在没有挂载 `tool-spill`
  的组合里同样有效。
- 新增发布子路径 `spill` / `spill-local` / `tool-spill`，需同步 `scripts/build.mjs`、
  根 `package.json` 的 `exports` 与 `test/publish.test.ts`。
- 未做：按会话清理溢出文件（目录按 `owner.sessionId` 分组已就位，但没有保留期策略）、
  读取/检索 API、非本地后端。

## 验证

- `packages/spill/spill-local/test/spill-local.test.ts`：定位符相对工作区、同一工具多次
  调用互不覆盖、建议文件名不被当作路径、按会话分组、真实存储失败以 `SpillError` 上报。
- `packages/spill/tool-spill/test/tool-spill.test.ts`：挂一个 Consumer 从未听说过的
  **fake 后端**，验证替换文本不超过上限、头尾都保留、省略字节数精确、`read_file` 跳过、
  后端失败时原文与调用结果都不变、多字节字符不在切点上被截断。
- 溢出说明的确切字样被**两侧**钉住：`tool-spill` 的 `formatSpillNotice` 与
  `apps/web/src/toolOutput.test.ts` 各存一份同样的字符串。web bundle 无法 import 工作区
  包，所以格式改动必须同时改两处 —— 只改一处会让生产者的用例或读取端的用例失败，作者因此
  会看到这对副本。措辞漂移的后果是被识别不出而降级成普通文本，不是崩溃。
- `apps/web/src/conversation/ToolActivity.test.ts` 验证超出上限的输出被封顶并能展开、
  溢出说明被提出来单独渲染。
- `pnpm typecheck` / `pnpm test`（817 条）/ `pnpm build` / `pnpm test:package` 全绿。
  `pnpm lint` 在本次改动之外仍有 27 条既有报错（`apps/desktop/scripts/*` 与
  `scripts/package-desktop.mjs` 缺 node 全局、`packages/agent/test/agent.test.ts:605`
  的 `require-yield`）。本次只把构建与打包产物目录补进 eslint ignores —— 否则任何打过桌面
  包的 checkout 都会先报出四千多条产物噪声 —— 其余既有报错未动。
