# 工具面收敛与文件写入对齐计划

> 状态：A–D、F、G、H 已实现；E 的 pruner 需重设计（见「零、进展 · 阶段 E」）
> 参考基线：`D:\task\deepseek-harness`（dsh）的 `packages/bundle/base/cordis.patch.yml`、
> `packages/fs/{fs-local,tool-fs,tool-str-replace-editor,fs-observation-policy}`、
> `packages/jobs/{jobs,jobs-local,tool-jobs}`、`docs/tool-catalog.md`、`docs/subsystems/filesystem.md`
> 取代关系：取代本次对话中先前的 `tool-catalog` 渐进式披露方案（已撤回，理由见「决策」1）
> 相关：`docs/adr/0006-capability-seams.md`、`docs/adr/0007-tool-output-spill.md`、`docs/adr/0008-sandbox-seam.md`

目标：让命令行会话具备与 Web/桌面一致的长会话能力（压缩、停滞看护、收尾续跑），
把模型可见的工具面从「全部常驻」收敛到 dsh base 的形状，给文件写入补上
「读后写 / 精确编辑 / 并发失配可自愈」这一层安全语义，并把临时脚本、长耗时命令、
异步等待这三个高频摩擦点写进提示词与工具参数。

---

## 零、进展

### 阶段 A · 已完成

改动的落点与计划基本一致，四处必须记录的偏差：

1. **不用「有注册表就查表、否则写 inbox」的分支判断，新增了 `agentSteer` 缝**
   （`packages/agent/src/steer.ts`）。原因：`loop-guard` 与 `continuationNudge` 都需要
   `steer` 与 `inject` 两个动词，分支判断会让它们各自重复一遍「谁在这个作用域里」。
   缝按作用域提供一次：`agents` 插件给注册表实现，`agent` 单例插件给自己的 inbox 实现
   （第一个提供者胜出，避免两个插件同时挂在根作用域时重复注册 `ctx` 键）。
2. **单例还需要一个「取回被 steer 的消息」的通道**。`AgentService._claimNextStepMessages()`
   在没有 `claimNextStep` 时原来直接返回空数组，于是 steer 成功也读不回来；
   现在退回 `claimQueuedInputs()`（排空内存 inbox）。`claimQueuedInputs()` 同时是测试的观察点。
3. **`job_start` 的 `ownerOf` 必须接受「有身份、无注册表」**。加上 `agentId` 之后，
   headless 的工具调用也带身份了，而 `ownerOf` 原来把「有 id 但注册表里查不到」当成错误 ——
   现在「没有注册表」= 无人归属，不再抛错（`packages/jobs/tool-jobs/src/index.ts`）。
4. **`tnega run` 的步数预算显式钉在 64**（`RUN_MAX_STEPS`，`--max-steps` 可覆盖）。
   挂上 loop guard 后，它的 `agent/step-limits` 回退上限（500）会取代原来的 64 ——
   对脚本与 CI 是一次静默的成本增加，所以固定下来，需要更长的运行显式传 `--max-steps`。

另外：`@tnega/runtime` 新增 `@tnega/compaction` 依赖（自动压缩要用 `autoContextBudget`），
`pnpm install --offline` 已执行，`pnpm-lock.yaml` 随之更新。

新增测试（`packages/cli/test/agent-runtime.test.ts`，「headless long-session capabilities」四项）：
无注册表时的 agent 身份与 `agentSteer` 可达性、`plugin:continue` 真的被注入、只给 `contextWindow`
就会自动压缩、`loopGuard` 的重复调用 nudge 生效。

验证：`tsc -p tsconfig.json` 通过；`packages/agent`（211）、`packages/loop/loop-guard`、
`packages/jobs/tool-jobs`、`packages/host`、`packages/project/host`、`packages/cli`
的 `agent-runtime` / `compose` / `web` / `jobs-web` / `processes-web` / `code-mode-web` 全绿。
已知无关失败：`packages/cli/test/cli.test.ts` 与同目录其他文件并行运行时有一次 TTY 文案抖动（单独运行通过）。

### 阶段 B · 已完成

文件工具落在 `packages/tools/src/fs/`（`read` / `write` / `edit` / `observed` / `atomic` / `lock` / `guards`），
`builtins.ts` 只剩注册。五处偏差：

1. **原子发布没有 Win32 那两个分支。** `@tnega/tools` 里没有 FFI，所以 `ReplaceFileW` 与 `copyFileDacl`
   都没实现：发布一律走 `rename`（Windows 上 libuv 用 `MoveFileEx` + `REPLACE_EXISTING`，替换仍是原子的），
   而 DACL 通过「临时文件建在工作区同目录的 staging 目录里」继承工作区的 ACE 来保住权限。
   计划里写的「FFI 不可用时降级 rename」因此变成「只有 rename」；真正的 `ReplaceFile` 留在
   `sandbox-windows-acl` 的 FFI 里，将来要补时是那一层的活。
2. **`read_file` 的正文不带行号。** 行号分页实现为「行窗口 + `lines: { start, end, total }`」，
   正文保持原样：`edit_file` 的 `old_string` 必须逐字匹配，给正文加行号会让模型把行号一起复制进
   `old_string`（dsh 的 `str_replace_editor` 就有这个坑，它靠提示词让模型自己剥）。
   行号改由错误信息提供 —— 歧义时报 `lines 1, 3`。
3. **`edits` 是「一起定位、一起应用、不许重叠」**，不是「依次应用」：每条 `old_string` 都在**原始内容**里
   定位，重叠直接报错。与 dsh 的 `applyEdits` 同义，也避免了「前一条改完后一条再也匹配不上」的连锁失败。
4. **观测只记「读到了整个文件」。** 超过 8MB 的文件按前缀读取，sha256 不完整，因此这次读**不授权**
   后续的受保护覆盖（dsh 用 provider 的 version，没有这个问题）。
5. **`ToolInputError` 迁到 `errors.ts`，参数读取函数收进 `input.ts`**，供 `builtins.ts` 与 `fs/*` 共用，
   避免 fs 模块反向 import `builtins.ts` 形成环。

为让 `edit_file` 立刻可用而提前落地的横切改动（原属阶段 D）：
`approval-host` 的 `WORKSPACE_WRITES`、`host/runs.ts` 的两处 preimage 守卫与 slash 运行时的 disabled 列表、
`workspace-files` 的 `writtenPaths`、`auto-approval` 的证据摘要（`edit_file` 的正文换成字符数）。
`project-activity` 与 `client/tools.ts` 本来就认 `edit_file`，无需改。

尚未接线：`fsGuard` 的 `--fs-guard` 与设置项（阶段 E），目前所有组合用默认 `warn`。

验证：`packages/tools/test/fs-tools.test.ts` 新增 16 项（分页、行长裁剪、歧义与重叠报错、`replace_all`、
并发串行化、staging 不残留、三档灰度、按 agent 记账、新建免读）；`packages/tools`（82）、
`approval-host`、`workspace-files`、`auto-approval`、`host`、`project/host`、`coding-agent`、
`cli` 的 `web` / `code-mode-web` / `processes-web` 全绿；`tsc` 与 eslint 干净。

### 阶段 C · 已完成

工具面从「全部常驻」收敛到 base + preset。实测（`JSON.stringify(schema).length` 之和）：

| 配置 | 之前 | 之后 |
|---|---|---|
| CLI preset，普通工作区 | 14,219 / 22 个 | **6,893 / 9 个** |
| CLI preset，工作区里有表格 | 14,219 | 13,424 / 13 个（office 四个按需挂上） |
| Project preset | — | 8,603 / 14 个（多 `now`、jobs、memory） |

五处偏差：

1. **`job_start` 不是被合并，而是被删除**（阶段 C.1）。`shell` 的 `runInBackground` 由
   `@tnega/tools` 声明、`@tnega/tool-jobs` 在 `tools/execute` 上接管 —— 在守卫已经决定之后，
   因此一条命令只批一次。若按原计划重新进入 `ctx.tools.execute`，同一条命令会过两遍守卫。
   `job_start({kind:'subagent'})` 也一并删除：`spawn_subagent` 本就异步返回，完成时投递 inbox，
   `list_subagent({wait_ms})` 可等待 —— 能力没丢，少了一个包装。
2. **技能索引没有搬成 durable 用户消息**，而是搭在唯一的 `skill` 工具描述上。
   它本来就在请求头里（稳定前缀、被缓存），真正的成本是四个 schema；改成用户消息反而要碰
   历史重写那套逻辑。记为对 dsh 的有意偏离。
3. **office 用「探测」而非「工作区提示」**：`hasOfficeFiles()` 扫两层，跳过
   `node_modules/.git/.worktrees/.pnpm-store/.tnega/dist/out`。work persona 例外 ——
   交付文档就是它的本职工作，`runs.ts` 对它传 `office: true`。
4. **preset 是一张三行的表**（`compose.ts` 的 `PRESETS`），不是插件化配置。`cli` 与
   `interactive` 目前同形（都不带 `echo/calculator/json/now`），`project` 多一个 `now`。
5. **`scopeTools` 落在 `@tnega/agent`**，不在 `@tnega/tools`：后者是 Agent 的下游，
   反向 import 才能给事件类型注解。project 的 `agent/request` 过滤改成调它。

顺带：`shell`、`skill`、`edit_file`、`read_file` 的描述按「一句话说完」重写，为的是把 CLI 面压到 7k 以下。

验证：`packages/tools`、`packages/runtime`、`packages/agent`、`packages/host`、`packages/project/host`、
`packages/coding-agent`、`packages/jobs`、`packages/approval-host`、`packages/client` 全绿；
`cli` 的 `compose` / `agent-runtime` / `web` / `code-mode-web` 全绿；`tsc` 与 eslint 干净。

### 阶段 D · 已完成

旧名字清理干净。剩下命中旧名的地方全是该保留的：`CHANGELOG.md` 与 `docs/releases/*`（已发布，
不可改）、`docs/superpowers/plans/2026-10-02-background-jobs.md`（历史计划）、
本文件（描述改动本身的前后对比）、ADR 0012 里作为沿革提到的一处，以及
`codingAgent.test.ts` 里明确断言「旧名已消失」的那一行。

改了什么：

| 位置 | 改动 |
|---|---|
| `coding-agent/src/skill-management.ts` | 删掉死代码 `skillCreateTool()` / `skillInstallTool()` 与只服务于它们的 `record()` / `textField()` |
| `coding-agent/test/slash.test.ts` | 假工具从 `skills_list` 改成 `skill` |
| `cli/test/project.test.ts` | 断言 `action=read`（索引文本变了） |
| `project/host/test/project-tool-scope.test.ts` | 不可见列表里 `job_start` 换成 `edit_file`（前者已不存在，断言变得无意义） |
| `tools/src/processes.ts`、`tools/src/builtins.ts` | 两处注释仍写 `job_start` |
| `coding-agent/README.md`、`cli/README.md`、`sandbox-windows-acl/README.md` | 工具名与用法 |
| `coding-agent/builtin-skills/{using-tnega,skill-create,skill-install}/SKILL.md` | **模型实际读到的指令** |
| `docs/guide/README.md` | 用户指南 |
| `docs/adr/0012-agent-browser.md` | 保留决策、修正事实（注明由 `job_start` 收敛为参数） |
| `.gitignore` | 补 `.tnega-*` |

**一个已知限制**：`installBuiltinSkills()` 是「只装缺失、绝不替换」，所以内置技能的文本改动
只影响新安装；已有用户在 home 里的副本仍写着旧工具名。这是那条安全属性（不覆盖用户指令）
的代价，不改，记在这里。

验证：`coding-agent`、`project/host`、`tools`、`cli/test/project.test.ts` 全绿；`tsc` 与 eslint 干净。

### 阶段 G · 已完成（并行工具调用）

实测：一条 assistant 消息里的多个并发安全调用真的同时在跑（测试用「同时在场峰值」度量，
串行时恒为 1）。改动集中在 `packages/agent/src/service.ts` 一处调度，外加各工具的一行声明。

**契约**（照 dsh）：`ToolDefinition.isConcurrencySafe?(input): boolean`，**纯同步分类器，
只认 `true`**；省略、抛错、返回别的都算独占。独占即栅栏 —— 它等前面的批落定，后面的批等它。

**实现要点**：

- 分批按**位置**划分连续区间，不重排。`Promise.all` 天然按输入顺序返回，所以结果回填仍是
  调用顺序 —— `agent/step-end` 的 `calls` 按下标对 result 的那份约定没有变。
- 整批先 `tool/start` + `tool/call` 落盘，再开始执行：日志与 UI 都先看到「这一组在跑」。
- 一个调用失败只结算成它自己的结果，不取消同批兄弟 —— 批是调度单位，不是事务。
- 未知工具名也当栅栏：它的失败是普通工具结果，产出这个结果的过程不该和别的东西竞争。
- `tool/result` 与 `tool/end` 按调用顺序落，不按完成先后。

**白名单**（声明为安全）：`read_file`、`list_dir`、`glob`、`grep`、`http_get`、`job_output`、
`job_list`、`office_read`、`office_inspect`。其余全部独占，包括 `shell`、`write_file`、
`edit_file`、`run_code`、`spawn_subagent`、`ask_user_question`、`job_kill`。

**`read_file` 为什么算安全**：它唯一的共享写入是观测记录（`agentId + 路径 → sha256`），
两次读同一路径写的是同一个值，可交换。注释与测试都钉了这一点。

**接受的一处代价**：`job_output` 有一个「读到第几个字符」的游标，两个并发读同一个 job 时
取决于交错，新输出可能交付两次、也可能一次而另一个为空 —— 两种情况都不丢内容。测试断言的是
「不丢」而不是「不重复」，并在注释里写明这是为了换取「读不同 job 可以并行」。上一版计划里我
把它描述成「UI 读到半新半旧」，那是错的：UI 读的是 `JobSnapshot`，不碰这个游标。

**为什么现在能做**：核实后，原先担心的三处不并行安全的地方有两处本来就没问题 ——
`spill-local` 按 `toolName-callId` 各自写文件、`ApprovalBroker` 按审批 id 挂起且前端并存、
`SessionLog.append` 有 `_queue` 串行链。真正需要改的只有调度本身。

验证：新增 `packages/agent/test/concurrency.test.ts` 六项（真实并行、位置对齐、独占即栅栏、
未知工具当栅栏、失败不连坐、按参数分类）；`packages/tools/test/fs-tools.test.ts` 加一项守卫
（读声明确实在、写声明确实没有），防止有人删掉声明后静默退回串行。`agent`、`tools`、`jobs`、
`search`、`tool-office`、`host`、`cli` 全绿。

### 阶段 E · 部分完成

**做完了**：

1. **`fsGuard` 三档接线**：`packages/config` 新增 `fsGuard?: 'off' | 'warn' | 'enforce'`（解析 +
   自动进 `SystemConfigPatch`）、CLI `--fs-guard=`（`index.ts` / `help.ts` / `commands.ts`）、
   `AgentRuntimeOptions.fsGuard` → `BuiltinToolsConfig`、host 的两条 run 路径透传
   （一次性运行与 resident 各自传 `config.fsGuard`）、Web 设置面板新增一项并标「实验性」
   （`SettingsDialog.tsx` + `packages/client` 的 `ConfigPatch` / 视图类型）。
   新增一项测试：`enforce` 下未读的覆盖被拒、读后可写 —— 证明设置真的传到了工具层。

2. **两条 ADR**：`docs/adr/0013-parallel-tool-calls.md`（契约、为什么默认独占、
   白名单、`job_output` 的代价）、`docs/adr/0014-atomic-file-writes.md`
   （staging 形状、`fsGuard` 为什么默认 `warn`、为什么用 sha256 而非 mtime、已知限制）。

**没做**：`tool-result-pruner`。两轮核对参考实现后，结论是**跨层比较导致的错误设计**：

1. **两者的层不同。** spill 是常驻的、每条工具结果产生时的**逐条准入控制**（`tools/post-execute`），
   按估算 token 计，全文落盘可恢复，`read` 豁免。pruner 是**压缩阶段**的动作：参考实现原文是
   「只有压缩触发条件成立时才裁剪，压力以下什么都不裁」，按字符计，写替换事件并把原文留在日志里。
   本计划最初写的那条（`tools/post-execute` 监听器 + 8192/4096/1024）把两者放到了同一层，
   于是得出「prune 会先削到 5KB、永远到不了 spill 的 50,000，且 pruner 不落盘 → 丢内容」——
   这个论断只对**那个错误设计**成立，对参考实现不成立。
2. **为什么两个都要**：单条 12,000 token 的结果 spill 会放行，但会话里攒 30 条就是 360,000 token，
   每条合规、总量爆窗。spill 管单条，管不了聚合；prune 是聚合层面的节食，且它的产出可能把压力
   降到不必摘要。
3. **对 tnega 的约束仍在**：`_assertReplayable` 要求请求能由日志重建，所以任何「只改请求、
   不改日志」的裁剪都会直接失败。要做得像 `session.compact` 那样落一次 surface 变更
   （新 `tool/result` 事件 + 引用原事件的来源标记），那是新的持久化语义，不是一次工具管线改动。
   这正是参考实现的做法（`sourceEventSeqs` + `compaction/prune` 记账事件）。

因此这一步需要重新设计，不在本阶段强行实现。备选方向（都还没定）：

- **A**：给 spill 加 per-tool 阈值，把 `read_file` 从 skip 列表里拿出来。
  它现在是唯一完全豁免的工具，而按行分页后单次读仍可达 `maxReadBytes`（256 KiB）。
  代价是模型读文件会看到溢出提示；收益是那个 256 KiB 的口子被堵上。
- **B**：真正的 pruner —— 压缩前先裁历史里的工具结果，若因此降到阈值以下就跳过摘要。
  需要新增一种 surface 变更事件，并让 `_assertReplayable` 认可它。

倾向 A（改动小、堵的是真实口子），但这是产品取舍，要单独决定。

### 阶段 F · 已完成

7 个包下沉到能力域目录，全部只落一级：

| 之前 | 之后 |
|---|---|
| `packages/office`（`@tnega/office`） | `packages/office/office` |
| `packages/tool-office` | `packages/office/tool-office` |
| `packages/ptc-runtime` | `packages/ptc/ptc-runtime` |
| `packages/ptc-runtime-quickjs` | `packages/ptc/ptc-runtime-quickjs` |
| `packages/tool-ptc` | `packages/ptc/tool-ptc` |
| `packages/user-questions` | `packages/questions/user-questions` |
| `packages/tool-question` | `packages/questions/tool-question` |

`packages/tools` 未动：它是缝定义，不是 consumer。

同步的清单（逐项核实过）：

1. `pnpm-workspace.yaml` 三行分组 glob；
2. `scripts/build.mjs` 的 `packageDirs` 七条映射；
3. `scripts/build.mjs` 的 `libraryEntries`：五条硬编码路径改走 `packageDir()`，并补 `office` / `tool-office` 两条
   （此前它们不在库入口表里，是从别处打包的）；
4. `scripts/build.mjs` 的 PTC worker 入口与 `pi-codemode` 的 realpath —— 后者第一次改错，
   `${}` 落在普通字符串里不会插值，已改成模板字符串；
5. 根 `package.json` 的五条 `exports.types` 路径；
6. `src/index.ts` 的五条 re-export；
7. `pnpm-lock.yaml`（由 `pnpm install --offline` 重写，importer 键与 workspace symlink 都已正确）；
8. `docs/adr/0010-ptc-tool-orchestration.md` 与 `docs/fix/2026-09-30-review-ptc.md` 的路径。

`tsconfig.build.json` 的 `include` 覆盖两级，无需改动；`tsc -p tsconfig.json` 与
`tsc -p apps/web/tsconfig.json` 都通过。

顺带产出 `packages/README.md`：能力域表 + 工具名到包的索引表 + 「加一个包要动哪四处」。
它补上了「统一 tool 目录」方案唯一的好处（好找），而不必拆散「三角缝同域」。

验证：`node scripts/build.mjs` 通过；`dist/types/packages/{ptc,questions,office}/…` 与
`dist/{office,tool-office,tool-question,ptc-worker,quickjs}.js` 都在；
`test/publish.test.ts` 12/12 通过，其中「resolves every documented subpath as a consumer
via package exports」正好覆盖这五条导出路径；`packages/{ptc,questions,office,runtime,agent,host}`
共 302 项通过。

### 阶段 H · 已完成：溢出恢复与读取预算

一次 context 溢出原本会直接失败整轮：压缩只有预防式（跨步的 0.75/0.9 比例），
`agent/request-error` 这个缝虽然存在，但没有任何监听者处理「窗口装不下」；
llm 层的重试只看 HTTP 状态（429/5xx），而溢出是 400。

**改了三处**：

1. **`isContextOverflowError(error)`**（`packages/agent/src/overflow.ts`）：按错误链上的
   `message` / `detail` 匹配各家实际文案（`prompt is too long`、`context_length_exceeded`、
   `maximum context length`、`input length and max_tokens exceed context limit` 等）。
   纯文本匹配、不 import llm 包，新 provider 不需要改代码。
2. **重试可以携带替换后的对话**：`AgentRequestRetryDecision` 新增 `messages?`。
   重试仍要过 `_assertReplayable`，所以替换必须已经持久化 —— 这不是新语义，
   和 `session.compact` 的既有约束一致。
3. **`agent/request-error` 的终端回调就是内建恢复**：插件先决定（有插件的决策就不动），
   没有插件时若错误是溢出且有 `contextBudget`，就走一次 `_compactForOverflow`
   （等于强制 `_compactNow`，与跨步压缩同一份实现），然后带 `messages` 重试。
   每步最多恢复一次：第二次溢出是真实失败，不是循环。

**顺带堵了 `read_file` 的口子**：它豁免 spill（否则「用 spill 的文件让模型再读一遍」会成环），
所以单次读没有任何上限 —— 默认 256 KiB ≈ 64k token，一次能吃掉半个 128k 窗口。
新增 `maxReadFileBytes`（默认 50 KiB，与参考实现的 `readMaxBytes` 同值），
`maxReadBytes` 保留给 `http_get`。

**为什么参考实现也豁免 `read`**：它的 README 明写「Results within budget, `read` … pass through」。
两个实现都选择「不溢出读取，而是压死单次读取的字节数」，所以这不是我们的将就。

验证：`packages/agent/test/context-overflow.test.ts` 六项（分类器识别各家文案、
溢出后压缩并重试成功、无预算时不恢复、无关 401 不误判、插件决策优先、第二次溢出不再循环）；
`packages/tools/test/read-budget.test.ts` 两项（100 KB 文件读到 ≤50 KiB 且 `truncated`、
小文件整读）。`agent` / `tools` / `spill` / `cli` / `host` 共 370 项通过；`tsc` 与 eslint 干净。

红色证据：实现前 `read_file` 返回 100,100 字节；溢出用例 3 项失败，其中一项报的正是
provider 的 400 原文。

---

## 一、验收标准

1. `tnega run` 与 `tnega web` 的能力面一致：自动压缩、loop guard、continuation 三者都生效，
   事件都带 `agentId`（今天 headless 下三者全部早退）。
2. 默认工具面字符数（`JSON.stringify(schema).length` 之和）：
   - CLI：14,219 → **≤ 7,000**
   - Web/桌面（native）：≈ 24,500 → **≤ 7,500**（browser、office、project 工具按条件挂载，不计入）
3. 文件工具具备：行号分页读取、唯一命中精确替换、并发失配自愈提示、按路径串行化、
   原子发布（读者永不见半个文件）。
4. `write_file` 覆盖已读未变的文件行为不变；覆盖未读或被外部改过的文件按 `fsGuard` 档位处理。
5. 跑脚本不再撞「无权限」：模型能找到一个跨命令存活、已 gitignore、被搜索排除的暂存目录。
6. 包目录成域：不再有散落在 `packages/` 根的 `tool-*` 包，且构建/导出/类型入口一处不漏。
7. 全部改动不触碰 CHANGELOG（发布 PR 才写）；设计变更同步 `docs/design/tnega-design.md`。

验收脚本（临时，不入库）：起 runtime 后 dump 每个 `schema` 的 JSON 长度并求和，跑 CLI 与 Web 两套配置，前后各一次。

---

## 二、决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | **不做渐进式披露**（撤回 `tools_load`/`tool-catalog` 网关） | dsh 的 plan-mode 提示词要求「工具目录跨模式不变以稳定请求缓存」；它靠 base bundle + preset 覆盖 + 按角色 `restrict` 收敛。我们照这三层，不引入运行时会变的 `tools` 字段 |
| 2 | 路径参数名保持 `path` | 改 `file_path` 要扫 30+ 处测试与文档 |
| 3 | `write_file` 覆盖的「先读」用 `fsGuard` 灰度，默认 `warn` | 实测 read_file 162 次 / write_file 566 次，直接强制等于凭空多出几百次读 |
| 4 | `job_start` 并入 `shell` 的 `runInBackground` | 与 dsh 的 `bash` 一致：`docs/tool-catalog.md` 里 `dsh-tool-jobs` 只注册 `job_output`/`job_kill`/`job_list` |
| 5 | **原子性按 dsh 本体：私有 staging 目录 + 原子发布**（不使用 in-place `O_TRUNC`） | 见「三」。`cordis-harness` 那套旧插件的 `O_TRUNC|O_NOFOLLOW` 不是 dsh 现行实现，早先版本照它写是错的 |
| 6 | `edit_file` 字段名用 `old_string`/`new_string`/`replace_all` | 同 dsh `tool-fs`，也同 Claude Code，模型语料最多 |
| 7 | 不做 `read_image`、不做 `str_replace_editor` | 前者需附件存储与视觉路由；后者是第二套编辑面，dsh 默认 preset 也不用 |
| 8 | 不新增独立 `wait` 工具 | 见「五」。dsh 也没有；修提示词 + 提高等待上限更省 |
| 9 | `read_file` 同时保留行窗口与字节上限 | 见「四·3」 |

---

## 三、dsh 的原子性为什么这样设计

实物在 `packages/fs/fs-local/src/fsio.ts` 的 `writeFileAtomic()`，流程是：

1. 在目标**同目录**建私有 staging 目录 `.<basename>.<pid>.<uuid>.tmpdir`，`mkdir` 后显式 `chmod 0700`；
2. 在其中 `open(temp, 'wx', 0o600)`（`wx` = 独占创建，已存在即失败）再 `chmod 0600`；
3. Windows 上先 `copyFileDacl(目标, 临时文件)` 把目标文件的 DACL 搬到临时文件；
4. 写入内容，`handle.sync()` 强制落盘，最后按原文件 mode `chmod`；
5. 发布三选一：
   - **新建**（`createIfAbsent`）→ `link(temp, target)`。硬链接原子**且不覆盖**，`EEXIST` 就是并发创建的检测点；
   - **Windows 替换** → `ReplaceFileW`（保留 ACL、属性、创建时间）；目标在暂存期间消失则退回 `rename`；
   - **POSIX 替换** → `rename(temp, target)`，同一文件系统内原子；
6. 成功后删 staging；失败时连 staging 一起清掉并抛出原始错误。

为什么这么设计（六条，都能对上代码）：

1. **读者不会看到半个文件。** `rename`/`link` 是目录项替换，原子。in-place `O_TRUNC` 的窗口里，任何读者（另一个 agent、编辑器、构建进程、文件监视器）都能读到截断内容。
2. **崩溃后目标文件仍然完整。** 写一半崩，残留的是 staging 里的垃圾，目标是旧的完整版本。in-place 的崩溃窗口留下的是**永久截断**的目标文件。
3. **`createIfAbsent` 需要「原子且不覆盖」。** POSIX `rename` 会原子地覆盖目标，正好破坏「create 不得覆盖」；只有 `link` 能一次完成「不存在则创建、存在则失败」。这是两套发布路径的根本原因。
4. **同目录 staging 而非系统临时目录。** `rename`/`link` 必须同一文件系统（跨设备 `EXDEV`）；沙箱也只需授权工作区，不必额外授权系统 temp。
5. **权限收紧的顺序。** staging 0700、临时文件 0600，只在发布前才 `chmod` 成原 mode —— 避免「文件还在写时对旁路进程可读」。
6. **Windows 两个补丁各有明确目标。** `ReplaceFile` 解决换文件丢 ACL/属性/创建时间；`copyFileDacl` 解决新文件继承目录 ACL、而非目标文件自己的显式 ACE。这两条正是在我们 ACL 沙箱下最要命的。

代价（dsh 接受，我们也要接受）：比 in-place 多约 80 行；`ReplaceFile` 与 DACL 复制要走 Win32 FFI；staging 残留需要清理（dsh 明确选择「发布已成功时清理失败不算失败」）。

**落地影响：**
- 我们已有 `packages/sandbox/sandbox-windows-acl/src/acl.ts` 的 koffi FFI 与 `grant-command.ts` 的 helper 进程模式，`ReplaceFileW` 可复用同一套基础设施。但 `grant-command.ts` 已记录：dev/vitest 形态没有 helper 产物，授予退回调用进程内执行 —— 原子发布的 Windows 分支要照同样方式降级（拿不到 FFI 就走 `rename` 并 warn）。
- `editedFiles` / preimage 抓取按工具结果里的 `path` 工作，换成原子发布不影响它。
- 「按路径内存锁」保留：原子发布解决**可见性**，不解决**读-改-写丢更新**，两者互补。

---

## 四、已定（本次拍板）

1. **包目录：方案 1 —— 补齐能力域目录**（照 dsh 的 `fs/`、`jobs/` 形状）。详见阶段 F。
2. **暂存目录：`.tnega/run/`**，环境变量 `TNEGA_RUN_DIR`
   （不带 `_DIR` 的 `TNEGA_RUN` 会和 `tnega run` 子命令撞名，读日志时容易误认）。
   与既有同级项并存：`.tnega/skills/`、`.tnega/mcp.json`。
3. **`read_file` 的 `maxBytes` 保留**，不是可有可无的遗留参数：
   - 行窗口管不了**单行极长**的文件（压缩后的 JS、单行 JSON、CSV），2000 行可以到几百 MB；
   - 字节上限是工具管线里唯一能挡住「一条工具结果吃光上下文」的硬闸（spill 与 pruner 都在它之后）；
   - 两者是正交的：`limit` 决定「看多少行」，`maxBytes` 决定「最多返回多少字节」，内部先取行窗口再按字节截断。

早先把它列为「待定删除」是想减少参数面，评估后撤回：删掉它只会把同一个上限藏进实现里，反而更难调到。

---

## 五、与参考实现的对齐差异（长期记住）

| 维度 | dsh | tnega 本次 | 说明 |
|---|---|---|---|
| 工具目录稳定性 | 硬约束 | 保持 | 不再引入动态目录 |
| 工具面收敛 | base / profile / preset / `restrict` | base + 一张 preset 表 + 现有 `agent/request` 过滤 | 不引入 Cordis patch 分层与插件市场 |
| 读取 | 行号 + `offset`/`limit` + 页脚；`readLimit` 2000 行、单行 2000 字符、单次 51200 字节 | 对齐 | |
| 写入前置条件 | `fs-observation-policy` 侧记 `fs/observed`，provider 做 `replaceIfVersion` CAS | 记账落在 `@tnega/tools` 内部 | 我们没有 fs 能力缝，这是缝债，不是终局 |
| 版本标识 | `dev:ino:size:mtimeNs:ctimeNs` | `sha256` | 仓库已有「Windows mtime 可比 `Date.now()` 超前 ~8ms」的教训，不能用 mtime 判 stale；dsh 的 ctime 组合在 Windows 上同样可疑 |
| 编辑语义 | `old_string`/`new_string`/`replace_all`，唯一命中 | 对齐 | |
| 原子性 | staging + `link`/`ReplaceFile`/`rename` | 对齐 | 见「三」 |
| 后台命令 | `bash` 自带 `run_in_background`；超时**不杀，转 job** | `shell.runInBackground`；超时仍杀（本次不做转换） | 转换要改 `@tnega/execution` 的 `runShell` seam |
| 技能 | 单个 `skill` 工具 + 会话级 durable 目录 | 对齐 | |
| 工具结果裁剪 | `tool-result-pruner`：压缩阶段裁剪，写替换事件并引用原事件 | 未实现，方案待定（见阶段 E） | 与 spill **不同层**：spill 管单条，prune 管聚合 |
| 重复调用提醒 | `repeat-tool-reminder` 阈值 [3,5,8] | 保留 loop-guard（nudge → 反思 → park） | 不抄数值 |
| 压缩 | session `surfaceOp` 替换 + 锁事件 | 保持 `contextBudget.summarize` | 改造远超收益，记入 ADR |
| 包目录 | 按能力域分组（`fs/`、`shell/`、`jobs/`、`web/`、`skill/`），**没有**统一 tool 目录 | 补齐缺的域目录 | 见阶段 F |

---

## 六、异步等待（不新增 wait 工具）

现象核实：`packages/jobs/tool-jobs/src/index.ts` 的提示段原文是
「Use job_start for … Use wait only when blocked; job_kill cancels unnecessary work.」
—— `wait` 指的是 `job_output({ wait: true, timeout_ms })` 的**参数**，措辞让它读起来像工具名。
模型因此去猜睡眠长度、等太长或太短再回来检查。

dsh 同样没有独立 `wait` 工具（`docs/tool-catalog.md` 无此项），做法是 `job_output` 的
`waitTimeoutMs` 默认 30s、`maxWaitTimeoutMs` 默认 **600s**，且「取消这次调用只取消等待，不影响 job」。
我们的 `maxWaitTimeoutMs` 只有 60s，模型因此必须反复重试。

三处修正，都在 `@tnega/tool-jobs`：

1. **改提示词**：「需要阻塞等待时用 `job_output({job_id, wait: true, timeout_ms})`；它只取消等待，不会停掉 job」。
2. **上限 60s → 600s**（默认仍 30s）。等待到期时结果里明确写「仍在运行，已等 Ns，下次可再等 M s」，把猜测变成读数字。
3. **在 `shell` 描述里写清分工**：等外部条件（CI、远端构建、端口）用 `shell` 里的轮询或 `browser_wait_for`；等**本 runtime 起的 job** 用 `job_output({wait:true})`。

评估过但不做：新增 `wait({seconds})` —— 只是把「猜睡眠」从模型脑内搬到参数里，还要多付一次工具往返；可中断的等待只有 `job_output` 的 wait 能做到。

---

## 七、临时脚本目录

现象核实（读代码得到的事实）：

- `packages/sandbox/sandbox/src/roots.ts` 的 `writableRoots()`：POSIX `workspace-write` 已给 `/tmp` 与 `os.tmpdir()`；**Windows 只给 `os.tmpdir()`** —— 那里没有 `/tmp`，`C:\tmp` 也不在授权里。这就是「访问 `/tmp` 没权限」的直接原因。
- `packages/sandbox/sandbox-windows-mxc/src/runner.ts`：`workspace-write` 下每次调用建一个**私有 temp 目录**并设为 `TMP`/`TEMP`，调用结束即删。所以 `%TEMP%` 下的文件**不能跨命令复用**。

结论与改动：

1. **不给 `/tmp` 开权限**（Windows 上那等于造一个跨会话共享、无人清理的可写根，与 ACL 按路径授权的粒度冲突）。POSIX 保持现状。
2. **在工作区提供 `.tnega/run/`**：首次使用时按需创建；跨命令存活；`shell` 执行环境注入 `TNEGA_RUN_DIR`（绝对路径），模型不必拼路径。
3. **提示词三分法**（`workspace-prompt` 的系统段落 + `shell` 描述）：
   - 一次性、跑完即弃的临时文件 → `%TEMP%` / `$TMPDIR`（MXC 下每次调用私有、自动清理）；
   - **要在多条命令之间复用的脚本** → `$TNEGA_RUN_DIR`；
   - 交付物 → 工作区正常路径。
   并明说「不要写 `/tmp`、`/var/tmp`、`C:\tmp`」。
4. **避免污染搜索与变更统计**：`.tnega/` 已在 `.gitignore`（已核实），`glob`/`grep`（ripgrep，遵守 gitignore）不受影响；
   但 `list_dir --recursive` 用 `DEFAULT_SEARCH_EXCLUDES`（`packages/search/search-definition/src/types.ts`，当前只有 VCS 目录与 `node_modules`），**没有 `.tnega`** → 补进去，`packages/workspace-files` 的隐藏集同源受益。
5. **落点**：`packages/tools/src/builtins.ts`（建目录 + 注入环境变量）、`packages/workspace-prompt/src/index.ts`（系统段落）。注意该插件现有段落是**用户写入的指令**，新增的是**系统约定**，两者要分开渲染，不能混进 `user-prompt.txt`。

---

## 八、改动清单

### 阶段 A · 运行时能力对齐（先做）

改 `packages/runtime/src/agent-runtime.ts`、`packages/agent/src/{service,live}.ts`、`packages/cli/src/{commands,index,help}.ts`。

1. **给 headless agent 一个身份。** `createAgentRuntime` 走 `agent` 单例路径，没传 `AgentConfig.agentId`，
   于是 `loop-guard`、`continuationNudge` 的 handler 全部在第一行 `if (!event.agentId) return` 早退。
   改为传稳定 id（与 `sessionId` 一致，缺省由 session 文件名派生）。
2. **补 steer 缝。** 两个插件都是先 `ctx.get('agents').get(id).steer(...)`，headless 没有注册表。
   在 `@tnega/agent` 增加服务 `agentSteer: { steer(agentId, input) }`：`agents` 插件查表，
   `agent` 插件写自己的 `AgentInbox`。两个插件都改成只走这一条（不留双路径）。
3. **给单例配 `claimNextStep`。** 否则 steer 成功也读不回来（`_requestContinuation` 依赖它取回消息）。
4. **挂三件能力**：`loopGuard: true`、`contextBudget: autoContextBudget({ llm, contextWindow })`、
   `continuationNudge` —— 与 `packages/host/src/runs.ts` 的 resident 路径一致。
5. **传 `contextWindow`。** `runAgentCommand` 现在完全不看窗口大小，改用
   `effectiveLlmConfig(config, env, model).contextWindow`（`packages/config/src/config.ts` 已有解析）。

验收：长任务出现压缩；「说要继续却不调用工具」的回复后能看到 `plugin:continue` 注入；`step/end` 带 `agentId`。

### 阶段 B · 文件工具（read / write / edit + 观测 + 原子发布）

改 `packages/tools/src/builtins.ts`（拆出 fs 工具），新增 `packages/tools/src/fs/` 下
`read.ts`、`write.ts`、`edit.ts`、`observed.ts`、`atomic.ts`、`lock.ts`，经 `packages/tools/src/index.ts` 导出。

1. **`read_file` → 行号分页，行窗口优先。** 参数 `path`、`offset?`（1 基）、`limit?`（默认并上限 2000 行）、
   `maxBytes?`（额外字节上限，内部先取行窗口再按字节截断）；单行超 2000 字符截断；
   页脚报「第 N–M 行，共 K 行」。这是 `edit_file` 可用的前提 —— 模型拿不到行号就无法写 `old_string` 定位。
2. **`write_file`**：新建不要求读过；覆盖按 `fsGuard` 三档；`append` 保留。
3. **新增 `edit_file`**：`{ path, edits: [{ old_string, new_string, replace_all? }] }`。
   每条必须精确命中一次（0 次 → 报「逐字未出现」并建议改用 `write_file`；多次 → 报出所有命中行号并要求补上下文）；
   多条先做重叠检查，全部通过才落盘；从后往前替换；返回新哈希与逐条行号摘要。
4. **观测记账**（`observed.ts`）：按 `agentId + 绝对路径` 记 `sha256` 或「确认不存在」；
   `read_file` 与成功的写/编辑都更新；不持久化（恢复的会话需重读，与 dsh 的已知限制一致）。
5. **原子发布**（`atomic.ts`）：照「三」的流程 —— 同目录私有 staging（0700）+ `wx` 临时文件（0600）
   + `sync()` + 按平台发布（`link` / `ReplaceFileW` / `rename`）+ 清理；Windows FFI 不可用时降级为 `rename` 并 warn。
6. **按路径串行化**（`lock.ts`）：`Map<path, Promise>`，防两个并行 subagent 同时改一个文件。
7. `interruption` 表登记 `edit_file: 'confirm'`。

### 阶段 C · 工具面收敛

1. **`job_start` 并入 `shell`。** `shell` 增加 `runInBackground`（仅当 `BuiltinToolsConfig.backgroundJobs`
   为真时出现在 schema）；`packages/jobs/tool-jobs/src/index.ts` 改为用 `tools/execute` 监听器接管，
   复用 `ADOPT_BACKGROUND_PROCESS` 与 `job/dispatch-*` 审计；删除 `job_start` 注册。
   保留 `job_output`/`job_kill`/`job_list`。`@tnega/tools` 不新增对 jobs 的依赖。
2. **`shell` 描述补长耗时指引**：「下载、安装依赖、构建、跑完整测试套件等命令，显式传更大的 `timeoutMs`
   （默认 15s）；本运行时到期即杀，不会自动转后台」。`ToolTimeoutError` 文案同步补一句「或对长耗时命令传更大的 `timeoutMs`」。
3. **技能四合一**：`{ action: 'list'|'read'|'create'|'install' }`；可用技能索引从 `skills_list` 的
   description 挪到**会话级 durable 用户消息**（dsh 做法），不再每轮重复。
4. **office 移出 base**：工作区探测到 `.xlsx/.docx/.pptx`（限 2 层，忽略 `node_modules`/`.git`/`.worktrees`/`.pnpm-store`）
   或调用方显式要求时挂载。省 6,531 字符（CLI 全量的 46%）。
5. **玩具工具下线**：`echo`、`calculator`、`json` 从默认面删除；`now` 只留在 Project preset（例行任务与报表要用日期）。
6. **preset 表**：`compose.ts` 增一张 `preset: 'cli' | 'interactive' | 'project'` → 能力列表映射，
   现有布尔开关作为覆盖。不引入 dsh 的 patch 分层。
7. **`restrict` 只做统一**：把 `packages/project/host/src/project-tool-scope.ts` 的 `agent/request` 过滤
   抽成 `@tnega/tools` 的公共 helper（`scopeTools(ctx, predicate)`），project 与其他组合共用。

### 阶段 D · 横切扫描（一次做完）

| 文件 | 改动 |
|---|---|
| `packages/approval-host/src/permissions.ts` | `WORKSPACE_WRITES` 加 `edit_file`；`skill` 按 action 分支（`list`/`read` 放行，`create`/`install` 写用户主目录需批准）；清掉 `job_start`、`echo`、`json`、`calculator`、`skills_list`、`skill_read` |
| `packages/host/src/runs.ts` | 两处 `request.name === 'write_file'` 的 preimage 守卫加 `edit_file` |
| `packages/workspace-files/src/file-edits.ts` | `writtenPaths` 认 `edit_file` |
| `packages/auto-approval/src/context.ts` | `historicalInput` 对 `edit_file` 也做摘要（旧/新正文换字符数） |
| `packages/loop/loop-guard/src/index.ts` | `DEFAULT_PROGRESS_TOOLS` 增 `skill`（`edit_file` 已在） |
| `packages/tools/src/builtins.ts` | `BUILTIN_INTERRUPTION` 增 `edit_file`；`DEFAULT_TOOL_NAMES` 同步；`.tnega/run` 创建与 `TNEGA_RUN_DIR` 注入 |
| `packages/search/search-definition/src/types.ts` | `DEFAULT_SEARCH_EXCLUDES` 增 `.tnega` |
| `packages/client/src/tools.ts` | `edit_file` 的 family/verb 已在；补 `skill`，去掉 `skill_read`/`skills_list` |
| `packages/project/host/src/project-tool-scope.ts` | `PROJECT_DISABLED_BUILTINS` 去失效名，改用公共 helper |
| 测试与文档 | `packages/approval-host/test/permissions.test.ts`、`packages/cli/test/{compose,jobs-web,processes-web,code-mode-web}.test.ts`、`packages/jobs/tool-jobs/test/*`、`packages/cli/README.md`、各包 README |

### 阶段 E · 裁剪层、灰度与收尾

1. **工具结果裁剪**：`packages/tools/src/prune.ts`，作为 `tools/post-execute` 监听器：
   **不按此设计实现**：它是压缩阶段的历史裁剪，不是 post-execute 策略。见阶段 E。
2. **`fsGuard` 三档**：`off` / `warn`（默认）/ `enforce`。
   - CLI：`--fs-guard=off|warn|enforce`（`packages/cli/src/index.ts` + `help.ts`）；
   - 设置：`packages/config/src/config.ts` 增字段，`apps/web/src/components/SettingsDialog.tsx` 新增一项并标「实验性」，
     `packages/host` 透传到 `BuiltinToolsConfig`；
   - `warn` 仍写入，但结果附「该文件在读取后被外部改动过，你的写入可能覆盖别人的修改」；
   - `enforce` 未读 → 拒绝并提示先 `read_file`；被改过 → 拒绝并给新哈希要求重读；
   - `edit_file` 的唯一命中校验不受档位影响（那是编辑正确性，不是并发策略）。
3. **文档**：`docs/design/tnega-design.md` 补「文件写入保护」与「临时脚本目录」；
   `docs/adr/` 新增「工具面：base + preset，不做动态披露」、「文件写入：staging + 原子发布」。
4. **CHANGELOG 不动**，留给发布 PR。

### 阶段 F · 包目录成域（方案 1）

现状（已核实）：15 个 `tool-*` 包，10 个已在能力域目录里
（`browser/`、`jobs/`、`memory/`、`project/`、`search/`、`session-search/`、`spill/`、`subagent/`、`web/`），
5 个散在 `packages/` 根。dsh 的实物也是按能力域分组（`fs/` 里放着 `tool-fs`），没有统一 tool 目录。

移动清单：

| 现在 | 移到 | 备注 |
|---|---|---|
| `packages/office`（`@tnega/office`，纯库：docx/exceljs/pptxgenjs） | `packages/office/office` | |
| `packages/tool-office` | `packages/office/tool-office` | |
| `packages/ptc-runtime` | `packages/ptc/ptc-runtime` | |
| `packages/ptc-runtime-quickjs` | `packages/ptc/ptc-runtime-quickjs` | |
| `packages/tool-ptc` | `packages/ptc/tool-ptc` | |
| `packages/user-questions` | `packages/questions/user-questions` | |
| `packages/tool-question` | `packages/questions/tool-question` | |

`packages/tools` **不动**：它是缝定义（`ToolsService` + 内置工具实现），不是 consumer。

> 后续修正（评审后）：`packages/tools` 只留注册表与共用词汇，内置工具按 dsh 的域拆出：
> `packages/fs/tool-fs`（读写编辑列目录）、搜索缝整体移到 `packages/fs/`、
> `packages/shell/tool-shell`、`packages/web/tool-web-fetch`；`echo` / `calculator` / `json`
> 删除，`now` 归 Project 域；preset 表随之删除（只剩 office 一项，已由 `office` 选项表达）。

必须同步的 7 处（已逐一核实存在，漏任何一处都会出现「构建找不到包 / 类型入口 404」）：

1. `pnpm-workspace.yaml`：加 `packages/office/*`、`packages/ptc/*`、`packages/questions/*` 三行。
2. `scripts/build.mjs` 的 `packageDirs`：加 6 条包名 → 路径映射（`office`/`tool-office`/`ptc-runtime`/`ptc-runtime-quickjs`/`tool-ptc`/`user-questions`/`tool-question`）。
3. `scripts/build.mjs` 的 `libraryEntries`：把 `'ptc-runtime'`、`'ptc-runtime-quickjs'`、`'tool-ptc'`、`'user-questions'`、`'tool-question'` 五条硬编码路径改成走 `packageDir()`。
4. 根 `package.json` 的 `exports` 类型路径：`./ptc-runtime`、`./ptc-runtime-quickjs`、`./tool-ptc`、`./user-questions`、`./tool-question` 的 `types` 字段（`./dist/types/packages/…` 前缀要加一层域目录）。
5. `src/index.ts` 的相对 re-export（`export * as … from '../packages/ptc-runtime/src/index.js'` 一类，共 5 处）。
6. `pnpm-lock.yaml` 的 importer 键（`pnpm install` 时自动重写；沙箱里若卡住就手工改键名）。
7. 文档里的路径引用：`docs/adr/0010-ptc-tool-orchestration.md`、`docs/fix/2026-09-30-review-ptc.md` 等散文链接；
   各包 README 的相对链接。

`tsconfig.build.json` 的 `include` 已覆盖 `packages/*/*/src/**/*.ts`（两级），本次移动全部只下沉一级，无需改动 —— 但要复核没有三级路径混进来。

顺带产出：`packages/README.md` 里加一张**索引表** —— 包名 → 注册的工具名 → 所属能力域，
解决「找工具」不必靠目录结构。这也补上了方案 2 的唯一优点。

---

## 八之二、并行工具调用

已实现，见「零、进展 · 阶段 G」。

---

## 九、风险

1. **阶段 C.1 波及最广**：`job_start` 散在 `permissions.ts` 白名单、`project-activity`、
   `code-mode-web`/`jobs-web`/`processes-web` 三组测试、prompt 文案与多份 README，约 30 处，必须一次改完。
2. **阶段 B 的原子发布**在 Windows 上依赖 FFI；dev/vitest 形态拿不到 helper 产物时要走降级分支，需要专门用例覆盖「降级为 rename」。
3. **观测记录不持久化**：恢复的会话第一次覆盖会落到 `warn`/`enforce` 分支，产生多余提示（dsh 同样接受）。
4. **压缩在 CLI 生效后**，`formatAgentRun` 的输出与 steps 计数会变，`test/publish.test.ts` 的断言要复核。
5. **`.tnega` 进 `DEFAULT_SEARCH_EXCLUDES`** 会影响 `list_dir --recursive` 与 `workspace-files` 的隐藏集，需复核有无用例依赖「能看到 `.tnega`」。
6. **阶段 F 是纯机械移动但容错低**：漏改导出或构建映射的表现是「本地 test 过、打包后 404」，所以要跟一次 `test:package`（`pnpm build && vitest run test/publish.test.ts`）。

---

## 十、不做

- **超时转后台**（dsh 的「到期不杀，转 job」）：要改 `@tnega/execution` 的 `runShell` seam，单独立项。
- **独立 `wait` 工具**：见「六」。
- **`read_image`**、**`str_replace_editor`**、**`todo_write`**、**动态工具披露**。
- **统一 `packages/tool/`**：会拆散「能力缝三角色同域」（ADR 0006），改用阶段 F 的方案 1 + 索引表。
