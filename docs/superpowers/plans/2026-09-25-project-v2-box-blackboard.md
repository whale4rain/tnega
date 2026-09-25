# Project v2：Box、Blackboard 与 Project Loop 实施计划

> 状态：M1–M9 已按模块落地，每个模块一个提交（`a31e1c7` … `283b8ef`）
> 取代关系：取代 [旧版实施计划](./2026-09-25-project-collaboration-implementation.md)（v1 任务运行时，作废）
> 当前设计：[Project v2 设计框架](../specs/2026-09-25-project-box-blackboard-design.md)
> 决策记录：[ADR 0008](../../adr/0008-project-box-blackboard.md)
> 已交付的包与 HTTP 面见 [docs/project/README.md](../../project/README.md)

**Goal:** 在 `main` 上按插件分模块交付 Project v2：用户与协调 Agent 的持续主对话、可独立干预的 Thread、共享的 Blackboard 记忆与产物、以及驱动父子协作的 Project Loop。

**Architecture:** Project Loop 是高于 Agent Loop 的独立插件。消息统一走 Box（信封 + 至少一次投递），共享事实走 Blackboard（有类型的版本记录 + 条件提交），大文件走 Artifact Store，Agent 身份与父子关系走 Thread。每个 Agent 恰有一个文件夹和一个 Session；Blackboard 不复制完整对话。

**Tech Stack:** Node.js 22+、pnpm、TypeScript strict、现有 `@tnega/core` Context/Fiber 插件、JSONL、原生 HTTP/SSE、React 19 + Radix Themes + Vite、Vitest。

**Spec:** [2026-09-25-project-box-blackboard-design.md](../specs/2026-09-25-project-box-blackboard-design.md)。

## Global Constraints

- **按插件分模块执行**：一次只做一个包（或一条缝的 Definition + Provider + Consumer），完成后立即提交，不攒到最后。
- **不写非必要测试**：只在行为微妙、失败会静默损坏数据的边界写测试（版本冲突、至少一次投递去重、崩溃恢复、父子路由）。其余靠 `pnpm typecheck` / `pnpm lint` 与真实运行验证。
- 每个模块一次 Conventional Commit，主题不超过 72 字符；只提交本模块相关文件。
- Provider → Definition、Consumer → Definition，两者互不依赖；Provider 的挑选属于 composition 层（[能力缝 ADR](../../adr/0006-capability-seams.md)）。
- 新包依赖放在 `packages/project/*` 与 `packages/loop/*`（缝容器目录，与 `packages/search/*` 同构）。
- 一个 Agent 一个 Session：Thread 身份稳定，配置不兼容时新建 Thread 而不是换 Session。
- 不启用旧版 `codex/project-collaboration` 的实现；只在接口与行为层面复用 Core、Agent、Session、durable inbox、权限与隔离执行代码。
- 复用现有普通 Session、Subagent、Plan/Goal、Memory 行为；Project 使用独立入口，默认配置不改变既有体验。
- 术语使用 `CONTEXT.md` 的「Project v2 目标术语」；实现落地后把该节的状态从「目标」改为「当前」。

## 机械步骤：新增一个包必须同时改的位置

新增包 `<dir>/<name>`（发布子路径 `<name>`）时一次改完这五处，否则 `pnpm build` 或发布校验会失败：

1. `pnpm-workspace.yaml`：新增容器 glob（`packages/project/*`、`packages/loop/*`）。
2. `packages/<dir>/<name>/package.json`：`@tnega/<name>`，`exports: { ".": "./src/index.ts" }`，依赖 `workspace:*`。
3. `scripts/build.mjs`：`packageDirs` 增加 `'<name>': 'packages/<dir>/<name>'`，`libraryEntries` 增加 `'<name>': \`${packageDir('<name>')}/src/index.ts\``。
4. 根 `package.json` 的 `exports` 增加 `"./<name>"`。
5. `test/publish.test.ts` 的子路径断言。

`tsconfig.build.json` 已含 `packages/*/*/src/**/*.ts`，`tsconfig.json` 已含 `packages/**/*.ts`，无需改动。`vitest.config.ts` 的 `packages/**/test/**/*.test.ts` 已覆盖新包测试。

## 模块与提交顺序

| # | 模块（提交） | 交付物 | 依赖 |
| --- | --- | --- | --- |
| M1 | `@tnega/blackboard` + `@tnega/blackboard-local` | 版本化事实、条件提交、原子批量、有序游标读取 | — |
| M2 | `@tnega/artifact-store` + `@tnega/artifact-local` | 内容寻址的产物存储 | — |
| M3 | `@tnega/project` + `@tnega/project-local` | Project 身份、词汇、`ctx.projects` 目录与 project scope | M1 |
| M4 | `@tnega/box` + `@tnega/box-blackboard` | 统一信封、至少一次投递、按收件人 ack | M1 |
| M5 | `@tnega/thread` + `@tnega/thread-local` | Thread 身份、Agent 文件夹与 Session、父子关系 | M1, M3 |
| M6 | `@tnega/project-loop` | Box 消费、唤醒、父子回报、崩溃恢复、assistant 消息回发 | M2–M5 |
| M7 | `@tnega/tool-blackboard`、`@tnega/tool-thread`、`@tnega/tool-box` | 模型可见的项目记忆 / 线程 / 消息工具 | M6 |
| M8 | `packages/cli` Project Host 与 HTTP/SSE | 创建与打开 Project、主对话、Thread、记忆、Library | M7 |
| M9 | `apps/web/src/project/` | 主对话 + Thread 卡片 + 侧边 Thread + Overview + Library + Memory | M8 |

依赖关系：M2 与 M1 可并行但按序提交；M6 必须等 M4、M5；M7 只依赖 Definition，可在 M6 前写，但排在 M6 后便于联调；M8 是唯一改 `packages/cli` 的模块；M9 只改 `apps/web`。

## 固定契约

后续模块使用这些名称与形状。任何扩展都要同时改本表、调用者与测试，不在不同模块自行换词。

### Blackboard：事实（`packages/project/blackboard`）

```ts
export type FactKind =
  | 'project'    // ProjectRecord：名称、目标、设置
  | 'agent'      // ThreadRecord：父子、状态、目标、工作目录或分支
  | 'memory'     // MemoryRecord：项目记忆条目
  | 'decision'   // DecisionRecord：采纳的决定及其来源
  | 'resource'   // ResourceRecord：资料索引（标题、来源、引用）
  | 'artifact'   // ArtifactRecord：产物索引（哈希、大小、媒体类型）
  | 'dependency' // DependencyRecord：Thread 之间的依赖
  | 'message'    // BoxEnvelope：消息信封
  | 'delivery'   // DeliveryRecord：某收件人的投递状态

export interface FactSource {
  messageId?: string
  sessionEventId?: string
  agentId?: string
}

export interface FactRecord<T = unknown> {
  kind: FactKind
  id: string
  /** Provider 分配的单调游标，只增不减，用作有序读取的 after。 */
  seq: number
  version: number
  data: T
  author: string
  source: FactSource
  createdAt: number
  updatedAt: number
  deleted: boolean
}

export interface FactCommit<T = unknown> {
  kind: FactKind
  id: string
  data: T
  author: string
  source?: FactSource
  /**
   * 条件提交。记录已存在时必填，省略即 BLACKBOARD_VERSION_REQUIRED；
   * 与当前版本不符即 BLACKBOARD_CONFLICT 并带回当前记录；
   * null 表示「这条记录必须尚不存在」。
   */
  expectedVersion?: number | null
}

export type BlackboardErrorCode =
  | 'BLACKBOARD_INVALID'
  | 'BLACKBOARD_VERSION_REQUIRED'
  | 'BLACKBOARD_CONFLICT'
  | 'BLACKBOARD_NOT_FOUND'
  | 'BLACKBOARD_FAILED'

export abstract class BlackboardService extends Service {
  constructor(ctx: Context) { super(ctx, 'blackboard') }
  abstract read<T>(kind: FactKind, id: string): Promise<FactRecord<T> | undefined>
  abstract list<T>(kind: FactKind, options?: {
    after?: number
    limit?: number
    includeDeleted?: boolean
  }): Promise<FactRecord<T>[]>
  /** 单条原子提交：读取当前版本、校验 expectedVersion、写入并递增版本。 */
  abstract commit<T>(input: FactCommit<T>): Promise<FactRecord<T>>
  /** 一批记录要么全部生效，要么全部不生效（Box 的信封 + 待投递记录用）。 */
  abstract commitAll(inputs: readonly FactCommit<unknown>[]): Promise<FactRecord<unknown>[]>
  /** 同一 kind/id 的历史版本，按 version 升序；用户纠错与追溯来源用。 */
  abstract history<T>(kind: FactKind, id: string): Promise<FactRecord<T>[]>
}
```

不变量：`seq` 全库单调；`version` 从 1 开始每次提交 +1；删除是 `deleted: true` 的新版本，不是行删除；`commitAll` 中的任一 `expectedVersion` 失败时整批不落盘。

### Artifact Store（`packages/project/artifact-store`）

```ts
export interface ArtifactPutRequest { content: string | Uint8Array; mediaType?: string }
export interface ArtifactRef { hash: string; size: number; mediaType: string }
export abstract class ArtifactStoreService extends Service {
  constructor(ctx: Context) { super(ctx, 'artifacts') }
  abstract put(request: ArtifactPutRequest): Promise<ArtifactRef>
  abstract get(hash: string): Promise<Uint8Array>
  abstract stat(hash: string): Promise<ArtifactRef | undefined>
}
```

哈希是内容摘要（sha256，十六进制，小写）。`get` 对未知哈希抛 `ARTIFACT_NOT_FOUND`。Blackboard 只存 `ArtifactRef`。

### Project（`packages/project/project`）

```ts
export interface ProjectRecord {
  id: string
  name: string
  goal?: string
  /** 主对话那个 Thread 的稳定 ID，创建时铸定。 */
  coordinatorId: string
  repo?: { path: string; branch?: string }
  createdAt: number
  updatedAt: number
}

export interface ProjectPatch {
  name?: string
  goal?: string | null
  repo?: { path: string; branch?: string } | null
}

export abstract class ProjectsService extends Service {
  constructor(ctx: Context) { super(ctx, 'projects') }
  abstract create(input: { name: string; goal?: string }): Promise<ProjectRecord>
  abstract list(): Promise<ProjectRecord[]>
  abstract get(id: string): Promise<ProjectRecord | undefined>
  abstract update(id: string, patch: ProjectPatch, author: string): Promise<ProjectRecord>
  abstract directory(id: string): string
}
```

只做身份与目录：没有 `remove`（删用户数据不可逆，产品也没有这个需求），也不在作用域里
预装运行时 —— Project 作用域里挂哪些 Provider 属于组合层。原稿的 `ctx.project`（绑定到
某个 Project 的服务）在实现时被去掉：真正需要 Project 身份的是 Project Loop（拿 config）、
模型可见工具（拿参数）与 Web 路由，没有任何一处需要「从 ctx 里取出当前 Project」，
留下它只会多出一个必须与 `ctx.projects` 保持同步的副本。

`project-local` 提供 `ctx.projects`：身份存在**同一作用域**的 Blackboard 的 `project`
记录里，磁盘目录是 `<root>/<projectId>/`。它 `inject: ['blackboard']`，Provider 由组合层
挑选，因此目录索引覆盖哪些 Project 由挂载位置决定。

### Box（`packages/project/box`）

```ts
export type BoxAddress = { kind: 'user'; id: 'user' } | { kind: 'agent'; id: string }
export type BoxMessageKind =
  | 'user-message'   // 用户在主对话发言
  | 'user-thread'    // 用户直接给某个 Thread 留言
  | 'agent-reply'    // Agent 面向用户的回复（含自动发布的 assistant 消息）
  | 'dispatch'       // 父 Agent 派工
  | 'progress'       // 子 Agent 进度
  | 'request'        // 子 Agent 请求决定
  | 'complete' | 'blocked' | 'failed'
  | 'notice'         // 可追溯的活动通知（用户给 Thread 留言时给协调者）

export interface BoxEnvelope {
  messageId: string
  projectId: string
  sender: BoxAddress
  recipients: BoxAddress[]
  placement: { kind: 'main' } | { kind: 'thread'; threadId: string }
  kind: BoxMessageKind
  text: string
  refs: ArtifactRef[]
  /** 分派卡片指向的 Thread。 */
  threadId?: string
  causationId?: string
  createdAt: number
}

export interface DeliveryRecord {
  messageId: string
  recipient: BoxAddress
  status: 'pending' | 'delivered' | 'acked'
  attempts: number
  updatedAt: number
}

export type BoxErrorCode = 'BOX_INVALID' | 'BOX_NOT_FOUND' | 'BOX_FAILED'

export abstract class BoxService extends Service {
  constructor(ctx: Context) { super(ctx, 'box') }
  abstract send(input: Omit<BoxEnvelope, 'messageId' | 'projectId' | 'createdAt'>
    & { messageId?: string; createdAt?: number }): Promise<BoxEnvelope>
  /** 未确认的消息，按 seq 升序。 */
  abstract inbox(recipient: BoxAddress): Promise<BoxEnvelope[]>
  /** 信封 + 全部收件人投递记录，按 seq 升序。 */
  abstract timeline(options?: { after?: number; limit?: number }): Promise<BoxEnvelope[]>
  abstract markDelivered(messageId: string, recipient: BoxAddress): Promise<void>
  /** 收件 Session 接纳并冲刷后才确认。 */
  abstract ack(messageId: string, recipient: BoxAddress): Promise<void>
  abstract delivery(messageId: string, recipient: BoxAddress): Promise<DeliveryRecord | undefined>
}
```

`box-blackboard` 用 `commitAll` 一次写入 `message` 与每个收件人的 `delivery`，然后 `ctx.emit('box/sent', envelope)`。`messageId` 可由调用方给定，用于「同一 Session 事件重复发布得到同一个 id」的幂等。

### Thread（`packages/project/thread`）

```ts
export type ThreadState = 'working' | 'waiting' | 'blocked' | 'idle' | 'done' | 'failed'
export type ThreadPermission = 'read-only' | 'workspace-write' | 'bypass'

export interface ThreadRecord {
  id: string              // 等于该 Agent 的 agentId，也是文件夹名
  projectId: string
  parentId?: string
  label: string
  goal: string
  expect?: string         // 期望回报
  state: ThreadState
  detail?: string
  depth: number
  permission: ThreadPermission
  createdAt: number
  updatedAt: number
}

export interface ThreadSpawnRequest {
  parentId: string
  goal: string
  label?: string
  expect?: string
  permission?: ThreadPermission   // 只能比父 Thread 更窄
}

export abstract class ThreadService extends Service {
  constructor(ctx: Context) { super(ctx, 'threads') }
  abstract spawn(request: ThreadSpawnRequest): Promise<ThreadRecord>
  /** 协调者 Thread：Project 创建时建立，parentId 为空，depth 为 0。 */
  abstract ensureRoot(project: { id: string; name: string; coordinatorId: string; goal?: string }): Promise<ThreadRecord>
  abstract get(threadId: string): Promise<ThreadRecord | undefined>
  abstract list(options?: { parentId?: string; descendants?: boolean }): Promise<ThreadRecord[]>
  abstract setState(threadId: string, state: ThreadState, detail?: string): Promise<ThreadRecord>
  /** 激活或恢复该 Thread 的 LiveAgent；同一 id 在进程内只有一个实例。 */
  abstract activate(threadId: string): Promise<LiveAgent>
  abstract idle(threadId: string): Promise<void>
  abstract sessionFile(threadId: string): string
}
```

Thread 文件夹是 `.tnega/projects/<projectId>/agents/<threadId>/`，含 `session.jsonl`；
可恢复配置（label / goal / state / depth / permission / 父子）是 Blackboard 的 `agent`
记录，身份本身写进 Session 的 `meta` 事件（沿用 `AgentRegistry.resume` 的既有机制）。
`depth` 上限由配置决定，默认 2；同一父 Agent 的并行子 Thread 上限默认 3。

首封工作消息**不**由 `spawn` 投递：那属于 Box 的职责，由 `tool-thread` 在 `spawn` 之后
发送，崩溃时靠 Project Loop 的重投补齐。`spawn` 只管身份、文件夹、Session 与父子关系。
代码 Thread 需要的分支与工作树字段在真正实现代码协作时再加，不预留空字段。

### Project Loop（`packages/loop/project-loop`）

```ts
export interface ProjectLoopConfig {
  projectId: string
  /** Thread 可继续向下创建的层数。 */
  maxDepth?: number
  /** 一个父 Thread 同时运行的子 Thread 数。 */
  maxChildren?: number
}
export const projectLoop: Plugin
```

职责边界：Project Loop 只做「谁收到消息、何时唤醒、父子回报、崩溃补齐」。它不调用模型、不改 Session 内容、不复制对话。

投递算法（对每个未 `acked` 的信封 × 收件 Agent）：

1. 读该 Agent 的 Session，若已有 `user/message` 事件的 `name` 等于 `box:<messageId>`，
   直接 `ack`（崩溃前已准入）。
2. 否则以 `messages: [{ role: 'user', name: 'box:<messageId>', content: text }]` 准入，
   `await agent.session.flush()` 后 `ack`。信封身份放在消息的 `name` 上：durable inbox 的
   `content` 只接受模型消息数组，放不下信封对象，而 `name` 恰好是 Session 会记下来的字段。
3. 状态先落定再唤醒：`status: 'working'` 的 Agent 用 `steer`（下个安全 step 边界进入），
   否则用 `followup` 起一轮；反过来的话收件方可能在唤醒后立刻跑完，随后到达的「开始工作」
   会把「空闲」覆盖掉。

自动发布：订阅每个已激活 Agent 的 `session/event`，对不带工具调用的 `assistant/message`
计算稳定 id `sha256(projectId, agentId, sessionEventId)` 取前 32 位十六进制，`placement`
取主对话（根 Thread）或该 Thread 面板（子 Thread），`causationId` 取该 Session 里最后一条
入站信封 id。重复发布因 id 相同而被 Box 的幂等路径吸收，属正常路径。

父子回报：`complete` / `blocked` / `failed` / `request` 信封到达时更新发送方 Thread 的
`state`；子 Thread 没有自己回报过时，Project Loop 用这一轮的最后一条回复补发 `complete`
给直接父 Agent（补发消息 id 由该回复事件派生，因此同一轮重复触发只命中同一个信封）。

## 每个模块的验收

- **M1** `packages/project/blackboard-local/test/blackboard.test.ts`：版本冲突返回当前记录、缺 `expectedVersion` 的更新被拒、`commitAll` 整批回滚、`seq` 有序游标、`history` 版本序。这是唯一必须写测试的模块，因为静默丢版本会污染全部上层。
- **M2** `pnpm typecheck` + 手工 `put`/`get` 往返：同内容两次 `put` 得到同一哈希。
- **M3** 创建 Project 后 `.tnega/projects/<id>/` 出现，`list()` 能看到，`open()` 返回同一记录；重复名称允许。
- **M4** `packages/project/box-blackboard/test/box.test.ts`：`send` 后 `inbox` 命中、`ack` 后不再出现、同 `messageId` 重复 `send` 不产生第二条信封。
- **M5** spawn 后子 Thread 出现在 `list({ parentId })`，重启进程后 `activate` 恢复同一个 Session（连续两次 `resume` 不产生新 meta）。
- **M6** `packages/loop/project-loop/test/loop.test.ts`：未 ack 的信封在重新挂载后被重投且不重复进入模型；子 Agent `complete` 后父 Agent 收到一条 inbox 消息；用户连续两条消息都在协调 Agent 未回复时被接纳。
- **M7** 三组工具在真实 Context 上注册且只在被授权的 Agent scope 可见。
- **M8** `pnpm tnega web` 后：创建 Project → 主对话发消息 → 卡片出现 → 打开 Thread 留言 → Thread 回复落回自己的面板。
- **M9** 刷新页面后主对话卡片与 Thread 详情一致；断线重连按游标补齐。

## 端到端验收场景（设计文档 §落地验证）

1. 用户连续发两条消息而协调 Agent 尚未回复。
2. 父子同时发送且消息不丢、不重复进入模型。
3. 创建子 Agent 后崩溃并恢复。
4. 子 Agent 完成后父 Agent 自动继续。
5. 用户直接改向正在运行的 Thread。
6. Blackboard 记忆并发更新与用户纠错。
7. 外部授权与内部自动合并的边界。
8. 重新打开页面后主对话卡片与 Thread 详情一致。

## 不在本次范围

- `packages/loop/agent-loop`：从 `@tnega/agent` 提取默认单 Agent Loop。它不改变行为，只是把现有实现换个容器，与 Project v2 无依赖关系；需要时单独一个提交做。
- Eval / Review 的正式验收流程（设计稿标注「暂时不做」）。
- 云端常驻、GitHub PR 自动处理、定时任务、跨用户共享、跨关机运行。
- 旧 `codex/project-collaboration` 数据的迁移；新旧持久化格式分开，旧数据先只读。
- 基于评测自动演化专业能力。
