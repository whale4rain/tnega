# Project 协作运行时与 UI Implementation Plan

> **旧版实施计划，已作废，不得继续执行。** 新设计见 [Project v2：Box、Blackboard 与 Project Loop](../specs/2026-09-25-project-box-blackboard-design.md)。本文件保留供历史对照。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 状态：计划已编写，尚未执行
> 取代关系：无；细化 [Project 协作运行时设计草案](../specs/2026-09-24-project-collaboration-design.md)
> 当前实现：基线 `12965f0`；本计划尚未执行。代码事实见 `packages/agent`、`packages/session`、`packages/cli` 和 `apps/web/src`。

**Goal:** 交付可从 Web / Desktop 创建并使用的本地 Project：主会话协调多 Thread，支持独立模型与工具、持续运行、持久审批、产物验收和恢复。

**Architecture:** `projectRuntime` 位于普通 Agent Loop 上方。Project Log 管理协作事实，每个 Execution 有独立 Session 和 scoped 工具；UI 通过命令和可追赶订阅工作，连接生命周期不控制任务生命周期。

**Tech Stack:** Node.js 22+、pnpm、TypeScript strict、现有 Context/Fiber 插件、JSONL、原生 HTTP/SSE、React 19、Radix Themes、Vitest、Testing Library/jsdom。复用现有 Git argv 执行和 LLM adapters。

**Spec:** [2026-09-24-project-collaboration-design.md](../specs/2026-09-24-project-collaboration-design.md)。

## Global Constraints

- 一个 Project 绑定一个源 Workspace；跨仓库、云端常驻、自由群聊和自动 profile 演化不属于本期。
- Project 创建的 Agent 一律使用 `manualStreaming: true`。
- 一个 Thread 同时最多有一个未结束的 Execution；一次 Execution 的 Session 最多一个 active Agent Run。
- Project Log 是协作状态真源；Session 是模型消息历史真源；工具结果文本继续只经 `renderToolResult`。
- 使用 Node.js 22+ 与 pnpm；保持 TypeScript strict 配置，不通过 `any`、类型断言或 lint disable 绕过错误。
- 每个独立验收项完成后自主 Conventional Commit，主题不超过 72 字符；只提交该项相关文件。
- 新包依赖遵循 Provider → Definition、Consumer → Definition；业务包不反向 import CLI。
- 每项先写失败行为测试，确认因目标功能缺失失败，再实现和复测；不能把模块解析/测试夹具错误当成 red。
- 保留现有普通 Session、Subagent、Plan/Goal 行为；Project 使用独立入口。
- 改公开事件或格式先落 ADR；新术语实现时更新 CONTEXT，当前用户文档只描述已可用功能。
- 当前变更只有计划文档；文中的代码片段是后续任务的契约和关键测试，不表示已经实现或运行。
- 按任务顺序执行。只有依赖已满足且文件互不重叠的任务才考虑子代理；本计划编写与复核不需要子代理。

## 交付阶段与依赖

| 阶段 | 任务 | 可验收结果 |
| --- | --- | --- |
| 持久模型 | 01–03 | 不调用模型即可创建、重开、验收及回放 Project |
| 执行基础 | 04–08 | 输入不丢、暂停可恢复、角色隔离、环境与权限有效 |
| 协作闭环 | 09–11 | Coordinator 能驱动依赖任务，预算、重投和重启有确定结果 |
| 服务协议 | 12 | UI 可使用完整命令、查询、项目流和 Session 流 |
| UI 数据与入口 | 13–14 | 可创建和切换 Project，断线追赶且不会串数据 |
| UI 完整体验 | 15–18 | 主会话、任务详情、验收、审批、暂停和恢复均可操作 |
| Eval 与交付验证 | 19–20 | 共用运行时评测、真实 API 验收、Web/Desktop 检查及发布验证 |

任务依赖：02→01；03→02；04→01；05→04；06→05；07→02；08→03、05、06；09→02、04–08；10→03、09；11→10；12→11；13→12；14→13；15→14；16→15；17→16；18→17；19→11、12；20→18、19。

## 文件布局与复用边界

| 路径 | 职责 |
| --- | --- |
| `packages/project/project/src/{types,commands,reducer,service,protocol,index}.ts` | Definition、状态规则、JSON 协议与安全 DTO |
| `packages/project/project-local/src/{log,lock,artifacts,index}.ts` | JSONL、独占写入、产物内容存储 |
| `packages/project/project-runtime/src/{profiles,execution,environment,approvals,scheduler,delivery,recovery,index}.ts` | 执行、审批与调度；各模块只公开任务中规定的接口 |
| `packages/project/tool-project/src/{coordinator,worker,index}.ts` | 模型可见工具 |
| `packages/cli/src/project-{runtime,host,routes,stream}.ts` | 组合、宿主缓存、HTTP 与 SSE |
| `apps/web/src/project/` | Project 功能目录，避免把新逻辑继续堆进 App/ChatView |
| `packages/eval/src/projectRuntime.ts` | 接受注入 HostFactory 的协作评测，不依赖 CLI |
| `test/helpers/project.ts` | Node 侧测试夹具，生产代码禁止导入 |
| `apps/web/src/project/fixtures.ts` | 小型 UI 夹具，仅测试使用，不包含 Node 依赖 |

Web 复用 `MessageBlock`、`ToolGroupBlock`、从 `ComposerFrame` 提取的纯展示层和现有 Session event 投影。新增 ProjectChat，不复用 ChatView 的 POST-run/AbortController 生命周期。现有 `apps/web/src/projectEvents.ts` 是 Session 消息投影函数，保留其名称和职责；新项目状态归约放在 `project/state.ts`，避免同名混淆。

现有 UI 测试发现规则只含 `*.test.ts`，因此 JSX 测试继续采用 `createElement` 和 `// @vitest-environment jsdom`，不新增测试框架。

## 固定契约

后续任务使用这些名称。接口扩展要同步本表、调用者和测试，不在不同阶段自行换词。

### 标识与状态

```ts
export type ThreadState =
  | 'open' | 'blocked' | 'awaiting_review' | 'completed' | 'cancelled'
export type ExecutionState = 'queued' | 'active' | 'suspended' | 'ended'
export type ExecutionOutcome =
  | 'submitted' | 'failed' | 'interrupted' | 'cancelled' | 'superseded'
export type BlockReason =
  | 'dependency' | 'approval' | 'user_input' | 'budget' | 'recovery' | 'integration'
export interface ProfileRef { id: string; version: string }
export interface ArtifactRef { id: string; revision: number }
export interface DecisionRef { id: string; revision: number }
export interface RevisionCheck {
  entity: 'project' | 'thread' | 'decision' | 'approval'
  id: string
  revision: number
}
export interface NewThread {
  id: string
  kind: 'coordinator' | 'worker'
  title: string
  goal: string
  acceptance: string[]
  profile: ProfileRef
  dependsOn: string[]
  inputs: ArtifactRef[]
  decisions: DecisionRef[]
}
export interface ThreadRecord extends NewThread {
  revision: number
  taskRevision: number
  state: ThreadState
  blocked: { reason: BlockReason; refId: string | null; detail: string } | null
  activeExecutionId: string | null
  createdByThreadId: string | null
}
export interface ExecutionRecord {
  id: string
  threadId: string
  taskRevision: number
  generation: number
  sessionId: string
  profile: ProfileRef
  profileHash: string
  state: ExecutionState
  outcome: ExecutionOutcome | null
  environmentId: string | null
}
```

ProjectRecord 包含 id、name、goal、workspace、revision、active/paused/archived、coordinatorThreadId、grant、limits。Grant 按“文件写入、shell、公开网络、私有网络、允许 MCP 工具、授权到期时间”显式记录；不使用一个权限等级代表所有集合关系。

ProjectState 包含 project，以及按 id 索引的 threads、executions、decisions、artifacts、approvals、outbox、commandResults、budgetReservations。集合都使用 JSON 可序列化对象或数组，不持久化 Map/Set。

### 命令、调用者与结果

```ts
export type ProjectActor =
  | { kind: 'user' }
  | { kind: 'runtime' }
  | { kind: 'agent'; threadId: string; executionId: string; generation: number }

export interface CommandHeader {
  commandId: string
  expected: RevisionCheck[]
}
export type ProjectCommand = CommandHeader & (
  | { type: 'thread/create'; thread: NewThread }
  | { type: 'thread/revise'; threadId: string; goal: string; acceptance: string[] }
  | { type: 'thread/dependencies'; threadId: string; dependsOn: string[] }
  | { type: 'thread/cancel'; threadId: string; reason: string }
  | { type: 'thread/reopen'; threadId: string; reason: string }
  | { type: 'thread/message'; threadId: string; text: string; mode: 'followup' | 'steer' }
  | { type: 'thread/submit'; executionId: string; taskRevision: number;
      summary: string; artifacts: ArtifactRef[]; evidence: ArtifactRef[] }
  | { type: 'thread/review'; threadId: string; submissionId: string;
      verdict: 'accept' | 'revise'; reason: string }
  | { type: 'project/control'; action: 'pause' | 'resume' | 'archive' }
)
export interface CommandReceipt {
  commandId: string
  projectRevision: number
  duplicate: boolean
  refs: string[]
}
```

这是任务 01 首批命令；任务 03/07/08/09/10 在自己的表中增加精确 payload，最终统一合并到 ProjectCommand，不新增第二套命令管线。commandId 重放时必须验证原 actor 与规范化内容 hash；相同 id 不同内容返回 COMMAND_ID_CONFLICT。内部 runtime 命令永不从 HTTP 用户请求接受。

```ts
export abstract class ProjectService extends Service {
  constructor(ctx: Context) { super(ctx, 'projects') }
  abstract command(command: ProjectCommand, actor: ProjectActor): Promise<CommandReceipt>
  abstract query(actor: ProjectActor): Promise<ProjectView>
  abstract watch(afterRevision: number, signal: AbortSignal): AsyncIterable<ProjectCommit>
}
```

query 返回全量授权 ProjectView；线程过滤与分页作为实现内逻辑，第一期不引入通用查询语言。ProjectView 包含项目摘要、Thread/Execution、决策和产物元数据、待处理事项以及预算统计；不包含凭据、原始 outbox、任意磁盘路径或内部授权令牌。ProjectCommit 保存 command、actor、timestamp、revision 和本次领域变化；内部日志与 UI stream 不是同一 payload。

ProjectService 的 Actor 必须在入口认证后由闭包绑定，禁止从模型参数或浏览器 JSON 读取。watch 为宿主内部接口，模型工具无订阅能力。

### 共同测试夹具

任务 01 创建 `test/helpers/project.ts` 并导出：

```ts
export function workerThread(id = 't1'): NewThread {
  return {
    id, kind: 'worker', title: 'Research', goal: 'Find primary sources',
    acceptance: ['Every finding has a source'],
    profile: { id: 'research', version: '1' },
    dependsOn: [], inputs: [], decisions: [],
  }
}
export function createThread(commandId = 'c1', id = 't1'): ProjectCommand {
  return { commandId, expected: [], type: 'thread/create', thread: workerThread(id) }
}
export const user: ProjectActor = { kind: 'user' }
export const runtime: ProjectActor = { kind: 'runtime' }
```

同文件实现 `tempWorkspace(): Promise<{path: string; cleanup(): Promise<void>}>`：mkdtemp 创建独立目录，cleanup 只删除该实际生成的临时目录；每个测试 finally 清理。执行期在 Windows 对照 AGENTS 路径删除约束。

## Task 01：Project 契约与纯状态转换

**Files:** 创建 `packages/project/project/package.json`、`README.md` 和上述 types/commands/reducer/service/protocol/index；创建 `packages/project/project/test/reducer.test.ts`、`test/helpers/project.ts`；修改 `pnpm-workspace.yaml`、`CONTEXT.md`；新增 `docs/adr/0008-project-runtime.md`。

**Consumes:** core Service / Context；设计稿。
**Produces:** 固定契约；`initialProject({id,name,goal,workspace,coordinatorThreadId}): ProjectState`、`decide(state,command,actor): ProjectChange[]`、`reduce(state,changes): ProjectState`。ProjectChange 为具体对象变更的判别联合，不是任意 JSON patch；无效输入抛带 code 的 ProjectError。

- [ ] 创建包清单，依赖只含 `@tnega/core`；注册 `packages/project/*` workspace 并更新 lockfile。先增加对应源码文件的合法空导出，让 red 来源是缺失行为。
- [ ] 写循环依赖、越权与过期提交测试。首个测试体：

```ts
it('rejects a dependency cycle before changing state', () => {
  let state = initialProject({
    id: 'p1', name: 'Demo', goal: 'Research', workspace: '/fixture',
    coordinatorThreadId: 'coordinator',
  })
  state = reduce(state, decide(state, createThread('c1', 'a'), user))
  const b = workerThread('b')
  b.dependsOn = ['a']
  state = reduce(state, decide(state,
    { commandId: 'c2', expected: [], type: 'thread/create', thread: b }, user))
  expect(() => decide(state, {
    commandId: 'c3', expected: [], type: 'thread/dependencies',
    threadId: 'a', dependsOn: ['b'],
  }, user)).toThrow('DEPENDENCY_CYCLE')
})
```

- [ ] 运行 `pnpm test -- packages/project/project/test/reducer.test.ts`，确认 red。
- [ ] 实现 decide：先校验 actor 的操作范围和 generation，再校验 entity revision，最后校验 DAG/生命周期。所有失败在生成变化前返回。关键转换：

```ts
export function cancelThread(thread: ThreadRecord): ThreadRecord {
  return {
    ...thread,
    revision: thread.revision + 1,
    taskRevision: thread.taskRevision + 1,
    state: 'cancelled',
    blocked: null,
  }
}
```

取消的 Execution 由后续 runtime 命令终结，不能在纯 reducer 中运行副作用。reopen 只接受 completed/cancelled，提升 taskRevision；review 必须针对当前 submission，agent 不能自验收自己生产的结果。未结束 Execution 唯一性由 reducer 校验。
- [ ] 写 ADR 的领域归属和生命周期决策；CONTEXT 增加提案已经落地的词汇，并更新 Agent Run 输入定义。
- [ ] 运行此测试和 `pnpm typecheck`；通过后提交 `feat(project): define durable collaboration model`。

## Task 02：本地日志、幂等命令与单写者

**Files:** 创建 `packages/project/project-local/package.json`、`README.md`、`src/log.ts`、`src/lock.ts`、`src/index.ts`；测试 `test/log.test.ts`、`test/lock.test.ts`。

**Consumes:** Task 01。
**Produces:** `openLocalProject({directory, initial}): Promise<{service: ProjectService; close(): Promise<void>}>`；`projectLocal` 插件用同一实现。directory 是已解析且限定在 Workspace 的项目目录。close 释放锁，不删除文件。

- [ ] 写真实临时目录测试：

```ts
it('deduplicates a committed command after reopen', async () => {
  const fixture = await tempWorkspace()
  const initial = initialProject({
    id: 'p1', name: 'Demo', goal: 'Research',
    workspace: fixture.path, coordinatorThreadId: 'coordinator',
  })
  const directory = join(fixture.path, '.tnega', 'projects', 'p1')
  let opened = await openLocalProject({ directory, initial })
  try {
    const first = await opened.service.command(createThread(), user)
    await opened.close()
    opened = await openLocalProject({ directory, initial })
    const again = await opened.service.command(createThread(), user)
    expect(again.duplicate).toBe(true)
    expect(again.projectRevision).toBe(first.projectRevision)
    expect((await opened.service.query(user)).threads).toHaveLength(1)
  } finally { await opened.close(); await fixture.cleanup() }
})
```

- [ ] 运行 `pnpm test -- packages/project/project-local/test/log.test.ts packages/project/project-local/test/lock.test.ts`。
- [ ] 实现单命令串行提交顺序，使用同一 writer 执行下列关键流程：

```ts
const changes = decide(state, command, actor)
const next = reduce(state, changes)
const record = makeCommit(state, command, actor, changes)
await appendAndSync(record)
state = next
publishCommitted(record)
return receipt(record)
```

`makeCommit` 在 log.ts 生成连续 revision、内容 hash 和结果引用；`appendAndSync` 用 FileHandle.write + sync；`publishCommitted` 只在 sync 后触发；`receipt` 从该记录导出 CommandReceipt。这四个内部函数同任务实现，通知失败不反转已经提交的事实。
- [ ] 实现锁：同进程重复 open 共用宿主引用；不同进程独占失败 PROJECT_IN_USE。锁保存 pid 与进程启动身份；无法确认旧进程已退出则拒绝接管。第一期不靠 TTL 抢锁。
- [ ] 测试尾行撕裂：仅末尾不完整记录可在持锁后备份并截去；中段坏 JSON 或 revision 缺口返回 CORRUPT_PROJECT_LOG，不能跳过。写入失败冻结 writer，watch 不发布虚假成功。
- [ ] 测试 watch 从 revision 精确回放、不丢订阅交界事件、abort 释放等待；相同 commandId 不同 actor/内容拒绝。
- [ ] 测试通过后提交 `feat(project-local): persist commands and replay state`。

## Task 03：Decision、Artifact 与提交验收

**Files:** 修改 project 的 types/commands/reducer/protocol；新增 `project-local/src/artifacts.ts`；测试 `project/test/review.test.ts`、`project-local/test/artifacts.test.ts`。

**Consumes:** Task 02。
**Produces:** 不可变 ArtifactRevision，DecisionRecord；`stageArtifact({sourceRoot,relativePath,directory}): Promise<{blobId,hash,bytes,mime}>`（字符串字段除 bytes:number）；stage 仅由可信宿主调用，不接受模型指定 sourceRoot。

新增命令 payload：

| type | payload |
| --- | --- |
| decision/propose | id、scope（project 或 threadId）、statement、rationale、evidence:ArtifactRef[] |
| decision/accept | id、revision、supersedes:DecisionRef\|null |
| artifact/register | id、revision、stagedBlobId、producerExecutionId、inputs:ArtifactRef[] |
| artifact/review | artifact:ArtifactRef、verdict:accept\|reject、evidence:ArtifactRef[]、reason |
| execution/submission-settled | executionId、submissionId、sessionSeq；仅 runtime |
| user-input/request | id、threadId、question；agent 仅限本线程或 coordinator |
| user-input/answer | id、text；仅用户，生成目标输入和 coordinator 通知 |

- [ ] 测试 artifact register 不能覆盖同 revision，decision accept 必须匹配当前 revision。测试产物接受与 Thread 接受分离：

```ts
it('keeps a completed artifact revision unchanged on rework', () => {
  const current = { id: 'a1', revision: 1, hash: 'hash-one', accepted: true }
  const next = { id: 'a1', revision: 2, hash: 'hash-two', accepted: false }
  const versions = appendArtifactRevision([current], next)
  expect(versions[0]).toEqual(current)
  expect(() => appendArtifactRevision(versions, next)).toThrow('REVISION_EXISTS')
})
```

`appendArtifactRevision<T extends {id:string;revision:number}>(versions:readonly T[],next:T):T[]` 在 reducer.ts 实现，要求同 id 的版本连续，保留旧对象。
- [ ] 运行两份目标测试确认 red。
- [ ] 实现 stageArtifact：resolve/realpath 检查越界和 symlink；流式 hash，临时文件 sync 后 rename 到内容寻址目录。先发布 blob，再提交引用；未引用 blob 只在显式清理中回收。
- [ ] thread_submit 首先持久保存 submission intent 并冻结写入，仍维持 Execution 未静止；收到 submission-settled 才进入 awaiting_review。恢复时检查提交 intent 与对应 Session 工具结果，不能因响应丢失创建第二份提交。
- [ ] 验收检查必需产物已存在、taskRevision 相符、验收主体有权限；退回保留旧结果并要求新 Execution。已采纳 Decision 改变时标记相关 Thread 输入失效，正在运行的结果不能直接接受。
- [ ] 运行目标测试与 typecheck；提交 `feat(project): track decisions and immutable deliverables`。

## Task 04：Session v11 与可恢复输入接纳

**Files:** 修改 `packages/session/src/index.ts`、`invariant.ts`、README；`packages/agent/src/inbox-durable.ts`、`live.ts`、`types.ts`、`service.ts`；新增 `packages/session/test/format-compat.test.ts`、`packages/agent/test/delivery.test.ts`；新增 `docs/adr/0009-session-input-admission.md`。

**Consumes:** 当前 v10 Session 与 Task 01 的需求；不 import project。
**Produces:** `SessionFormatVersion = 10 | 11`；SessionLog 构造函数第四参数 `{formatVersion?:SessionFormatVersion}`；AgentCreationOptions 同名可选字段。不存在文件默认 v10，已有文件按文件头；项目显式创建 v11。

```ts
export interface DeliveryReceipt {
  deliveryId: string
  inboxId: string
  stage: 'queued' | 'claimed' | 'admitted'
}
receiveOnce(
  deliveryId: string,
  input: AgentInput,
  mode: 'followup' | 'steer',
): Promise<DeliveryReceipt>
deliveryReceipt(deliveryId: string): Promise<DeliveryReceipt | undefined>
```

以上两个方法加入 LiveAgent；稳定 id 只在 v11 接口可用，v10 调用明确返回 UNSUPPORTED_SESSION_CAPABILITY。输入多条消息时使用 deliveryId+partIndex；同 id 不同输入 hash 拒绝。

- [ ] 写兼容与去重测试：

```ts
it('queues one input for repeated delivery', async () => {
  const f = await makeDeliveryFixture()
  try {
    await f.agent.receiveOnce('d1', { text: 'Research sources' }, 'followup')
    await f.agent.receiveOnce('d1', { text: 'Research sources' }, 'followup')
    expect(f.agent.inbox.size).toBe(1)
    await expect(f.agent.receiveOnce('d1', { text: 'Other work' }, 'followup'))
      .rejects.toThrow('DELIVERY_ID_CONFLICT')
  } finally { await f.close() }
})
```

`makeDeliveryFixture():Promise<{agent:LiveAgent;close():Promise<void>}>` 在 delivery.test.ts 内实现：临时目录、空 tools、agents、v11 Session、manualStreaming:true、返回固定文本的 fake adapter；close 先 dispose 再删临时目录。
- [ ] 运行两份目标测试确认行为 red。
- [ ] 在 inbox 串行队列内执行选择输入→持久 claim→移除队列。首轮 claim 关联放 turn/start.input；next-step claim 放 meta(kind:agent/input-claim)。每条 user/message 同事件记录 provenance，不能另写一个“已接纳”标记来猜测。
- [ ] 恢复从 raw 日志重建 receipts；已 claimed 未 admitted 的部分入队，已 admitted 不重复入队，已压缩历史仍保留接纳事实。去重后 receipt 仍需 flush 才向 outbox 确认。
- [ ] 为以下落盘切点各写故障注入测试：写 claim 前、claim 后、删除后、第一条多消息 admitted 后。v10 加载/追加保持原语义，v11 明确拒绝非法 provenance，Fork 不携带源 Session 的接收去重索引作为新投递结果。
- [ ] 更新 ADR/README、运行目标测试及 agent/session 相关回归、typecheck；提交 `feat(session): add versioned durable input admission`。

## Task 05：通用执行暂停与终止后的工具闭合

**Files:** 修改 `packages/tools/src/index.ts`、`packages/agent/src/{types,service,live}.ts`、Session 结束原因及 invariant；新增 `packages/agent/test/control-boundary.test.ts`，更新 tools/agent README。

**Consumes:** Task 04。
**Produces:** ToolResult/ToolExecuteOptions 新增可选 `control: {kind:'suspend';reason:string;refId:string} | {kind:'finish'}`；AgentRunResult 可选 control；v11 turn/end 保存该结果。普通 concludesTurn 行为不变。

- [ ] 测试同轮先暂停再写文件不会执行后者：

```ts
it('records skipped results without executing tools after suspension', async () => {
  const f = await makeControlFixture()
  try {
    await f.agent.followup({ text: 'Do work' })
    for await (const event of f.agent.runTurns()) f.events.push(event)
    expect(f.writeCount()).toBe(0)
    const events = await f.agent.session.read()
    expect(events.filter(e => e.type === 'tool/result').map(e => e.payload.ok))
      .toEqual([false, false])
    expect(f.agent.inbox.size).toBe(0)
  } finally { await f.close() }
})
```

`makeControlFixture` 在测试文件创建 v11 manual Agent；fake adapter 一次返回 request_approval 和 write 两个 toolCalls；首工具设置 options.control=suspend 并返回拒绝结果，write 递增计数；events 为 AgentStreamEvent[]。
- [ ] 运行目标测试确认 red。
- [ ] 在 service 工具循环遇到 control 后，将剩余调用逐个写 tool/call + skipped tool/result，不执行真实工具；仍闭合 step/turn。driver 返回给调度器，不继续 drain 待处理 inbox。关键分支：

```ts
if (control) {
  result = skippedToolResult(call, control)
} else {
  result = await tools.execute(call.name, call.arguments, toolOptions)
  control = result.control
}
```

`skippedToolResult(call,control):ToolResult` 产生 ToolSkippedError、ok:false 和原始 input；无工具副作用。tools 的成功与失败构造均保留 options.control，避免 guard 拒绝路径丢失 suspend。
- [ ] 补测试：finish 后后续写入跳过；暂停时新 steer 保留待接纳；恢复前不自动唤醒；普通 v10 concludesTurn 回归；runTurns 被调用者提前关闭时也完成收尾。
- [ ] 测试通过、typecheck 后提交 `feat(agent): suspend runs at durable control boundaries`。


## Task 06：WorkerProfile、模型路由与 scoped 工具

**Files:** 创建 `project-runtime/package.json`、README、`src/profiles.ts`、`src/execution.ts`、`src/index.ts`；测试 `test/profiles.test.ts`。修改 Agent 测试夹具以覆盖 profile 场景。

**Consumes:** Tasks 04–05，AgentRegistry/setup、现有 model adapter 和 ToolsService。
**Produces:** 以下固定接口；ProfileResolver 由组合层注入，不从 runtime 导入 CLI config。

```ts
export interface WorkerProfile {
  id: string
  version: string
  role: 'coordinator' | 'research' | 'coding' | 'reviewer'
  description: string
  model: { routeId: string; effort: string; contextWindow: number }
  system: string
  bundles: string[]
  resources: string[]
  maxSteps: number
  maxOutputTokens: number
  grant: ProjectGrant
}
export interface CompiledProfile {
  source: WorkerProfile
  hash: string
  llm: LLMAdapter
  setup: AgentSetup
}
export type ProfileResolver =
  (ref: ProfileRef, environment: ExecutionEnvironment) => Promise<CompiledProfile>
```

ProjectGrant 在 Task 01 定义；ExecutionEnvironment 的完整字段由 Task 07 定义，Task 06 先使用该契约声明：id、sourceWorkspace、cwd、kind（readonly/git/exclusive）、baseCommit:string|null、manifestHash:string|null。

- [ ] 实现测试所需 `createProfileAgent(registry,execution,compiled,file):Promise<AgentHandle>`，先给出导出再写 red：

```ts
it('gives workers separate executable registries', async () => {
  const f = await makeProfilesFixture()
  try {
    const coordinator = await f.create('coordinator')
    const coder = await f.create('coding')
    const research = await f.create('research')
    expect(coordinator.agent.agentCtx.tools.has('shell')).toBe(false)
    expect(coder.agent.agentCtx.tools.has('shell')).toBe(true)
    expect(research.agent.agentCtx.tools.has('shell')).toBe(false)
    await expect(research.agent.agentCtx.tools.execute('shell', {}))
      .rejects.toThrow('tool not found')
  } finally { await f.close() }
})
```

`makeProfilesFixture` 在 profiles.test.ts 实现真实 Context/AgentRegistry，安装空根 tools；各 profile 的 fake adapter 分别记录请求；shell 为只记次数的测试工具，不启动进程。create 使用固定版本配置；close 逆序 dispose 所有 handle。
- [ ] 运行目标测试确认 red。
- [ ] 编译已批准 bundle 名单到 setup，禁止模块路径或模型提供可执行插件。setup 内新建 ToolsService/systemPrompt，显式挂本 scope 的 guard，并装配与 cwd 相符的 search/spill/memory；MCP 配置按允许的 server/tool 子集装配，按 Fiber 清理。
- [ ] 使用创建参数传 llm；记录已解析模型配置的无密钥快照和 profile hash。创建关键参数：

```ts
return registry.create({
  id: execution.sessionId,
  sessionId: execution.sessionId,
  file,
  formatVersion: 11,
  manualStreaming: true,
  llm: compiled.llm,
  contextWindow: compiled.source.model.contextWindow,
  maxSteps: compiled.source.maxSteps,
  setup: compiled.setup,
})
```

恢复采用同样参数与 registry.resume；现有 Session 不重新注入 initial input。
- [ ] 补测试：不同 adapter 各收到自己的请求；改全局配置不改变已运行 profile；缺失版本/模型路由返回阻塞；scoped guard 在独立工具实例有效；MCP dispose 无泄漏；项目 profile 无 spawn_subagent。
- [ ] 目标测试与 typecheck 通过后提交 `feat(project-runtime): isolate worker profiles and capabilities`。

## Task 07：执行环境、写入互斥与代码集成

**Files:** 创建 `project-runtime/src/environment.ts`、`test/environment.test.ts`；扩展 project 的 environment/integration 类型与命令；修改 runtime README。

**Consumes:** execution.runProcess（无 shell argv）、Task 02 锁、Task 03 Artifact。
**Produces:** `prepareEnvironment(request):Promise<ExecutionEnvironment>`、`integrateArtifact(request):Promise<IntegrationResult>`、`releaseEnvironment(id):Promise<void>`。release 只释放活跃租用，不删 worktree。

PrepareEnvironmentRequest = executionId、workspace、projectDirectory、mode:readonly|git|exclusive、source:SourceSelection、signal。SourceSelection = `{kind:'head';commit:string}` 或 `{kind:'snapshot';commit:string;files:string[]}`。IntegrationRequest = environment、acceptedArtifact、targetRef、expectedTargetCommit、signal；IntegrationResult = `{status:'integrated';commit:string}` 或 `{status:'conflict';files:string[]}`。

新增 runtime 命令：environment/ready（executionId、environment）；integration/request（artifact、targetRef、expectedTargetCommit，用户或 coordinator）；integration/result（requestId、result、evidenceRefs，仅 runtime）。集成命令通过 Project grant，不能绕过工具批准。

- [ ] 写真实临时 Git 仓库测试：

```ts
it('keeps worker edits outside the source checkout', async () => {
  const f = await makeGitFixture()
  try {
    const env = await prepareEnvironment(f.request)
    await writeFile(join(env.cwd, 'example.txt'), 'worker')
    expect(await readFile(join(f.path, 'example.txt'), 'utf8')).toBe('base')
    expect(env.cwd).not.toBe(f.path)
  } finally { await f.close() }
})
```

`makeGitFixture` 在测试文件用 runProcess 执行 git init、局部 user 配置、add/commit；记录真实 initial commit；request 使用 git 模式和该 commit；close 先 git worktree remove 仅测试产生的目录，再验证路径后删除 fixture。
- [ ] 运行目标测试确认 red。
- [ ] 解析 realpath 和 Workspace 标识；Git 起点必须解析到固定 commit。执行 `['git','worktree','add','-b',branch,path,commit]`，branch 使用 codex/project-加稳定 executionId；启动恢复复用已创建且归属正确的 worktree。
- [ ] 源目录脏时不默认忽略：未指定 source 返回 SOURCE_SELECTION_REQUIRED。snapshot 仅打包用户确认 manifest 的路径，包含追踪修改和明确选定的未跟踪文件，排除 .git/.tnega 与目录逃逸；内容 hash 固定，错误必须报告。
- [ ] research 使用只读来源和独立 artifact staging 目录；非 Git 的可写任务取得 Workspace 单写租约。不同 Project 同源也互斥；取消后等工具停止才释放。
- [ ] 集成只对 accepted 代码 Artifact，在隔离集成分支做 merge。目标 commit 不匹配则返回冲突；冲突保留现场，不改用户工作树。最终集成 commit 单独发布验证证据。任何 push/deploy 不包含在本操作内。
- [ ] 补测试：并发非 Git 写入等待；目录大小写别名不重复租约；dirty source 两种明确选择；第二次 prepare 幂等；取消不删产物；两个独立通过的补丁合并后验证失败不标完成。
- [ ] 测试通过提交 `feat(project-runtime): isolate workspaces and integrate revisions`。

## Task 08：项目授权、持久审批与恢复许可

**Files:** 创建 `project-runtime/src/approvals.ts`、`test/approvals.test.ts`；扩展 project types/reducer/protocol；不改变普通 Session 的 ApprovalBroker。

**Consumes:** Tasks 03、05、06；ProjectService；运行上下文中的可信 execution/generation。
**Produces:** `projectPermissionGuard(binding):ToolGuard`、`intersectGrants(grants:readonly ProjectGrant[]):ProjectGrant`；ApprovalRecord 的字段为 id、revision、threadId、executionId、generation、tool、argumentHash、environmentId、grantRevision、expiresAt、state（pending/approved/denied/consumed/expired）、safePreview。

新增命令：approval/request（完整受信调用绑定，仅 runtime）、approval/decide（approvalId、allow，仅 user）、approval/consume（approvalId、actualCallHash、executionId、generation，仅 runtime）、grant/revoke（范围和理由，仅 user）。拒绝/到期生成可恢复结果，绝不执行原工具。

- [ ] 测试批准不能授权变更后的参数：

```ts
it('does not spend approval on changed arguments', () => {
  const approval = approvedCall({
    tool: 'shell', argumentHash: 'hash-a', environmentId: 'env1',
  })
  expect(canConsumeApproval(approval, {
    tool: 'shell', argumentHash: 'hash-b', environmentId: 'env1',
    executionId: 'e1', generation: 1, grantRevision: 1, now: 100,
  })).toBe(false)
})
```

`approvedCall` 在测试文件构造所有字段齐全的 approved ApprovalRecord（executionId=e1、generation=1、grantRevision=1，expiresAt>100）；`canConsumeApproval(record,call)` 定义在 approvals.ts，call 还包含 executionId/generation/grantRevision/now，测试夹具统一提供有效固定值，实际断言只覆写 hash。
- [ ] 运行目标测试确认 red。
- [ ] guard 先交集有效 grant。超权时持久 approval/request，然后给 ToolExecuteOptions 设置 suspend control，返回 approval-required；工具真实 execute 不调用。
- [ ] 使用规范化 JSON 的稳定 hash 绑定参数与环境，预览脱敏。一次调用允许只通过 actor=runtime 消费，并在真实执行前同步记录 consumed；消费后崩溃不能自动补发。
- [ ] 批准将 Execution 转为可调度状态并投递恢复输入；真实新调用重验参数与 generation。到期、撤销和拒绝写 durable 记录，UI 连接不影响审批寿命。Grant 上限增加只能由用户动作完成。
- [ ] 补测试：关页面/重启仍看到 pending；重复 decide 幂等；旧 generation 不可消费；权限交集不能扩大；approved 后失效不能执行；挂起任务不持有执行 slot。
- [ ] 测试/typecheck 通过提交 `feat(project-runtime): persist bounded approvals`。

## Task 09：调度器、配额与受控 Agent 生命周期

**Files:** 创建 `project-runtime/src/scheduler.ts`、`test/scheduler.test.ts`；扩展 execution.ts/index.ts 与 project 命令。创建测试 harness `project-runtime/test/harness.ts`。

**Consumes:** Tasks 02、04–08。
**Produces:** `projectRuntime` 插件、`ProjectRuntimeHandle { reconcile():Promise<void>; stop():Promise<void> }`；`selectRunnable(view:ProjectView,limits:RuntimeLimits):string[]`。RuntimeLimits 包含 workerConcurrency、coordinatorConcurrency（固定 1）、perProfileConcurrent、maxTokens、maxDurationMs、maxReworks。

新增 runtime 命令：execution/queue（ExecutionRecord+配置引用）、execution/start（executionId）、execution/suspend（executionId、reason/refId）、execution/end（executionId、outcome、sessionSeq）、budget/reserve（reservationId、executionId、maxTokens）、budget/settle（reservationId、tokens:number|null、cost:number|null）、thread/block（threadId、reason/refId/detail）。状态写入经过同一 ProjectService。

- [ ] 用真实 ProjectService 与 fake adapters 创建 `makeRuntimeHarness(options?)`，返回 service、runtime、registry、adapters、close；options 可设置 limits 与初始 profiles。adapter 支持显式 Promise 屏障，不用固定 sleep。
- [ ] 测试两个同时 reconcile 不能重复启动：

```ts
it('starts one execution for concurrent scheduling requests', async () => {
  const f = await makeRuntimeHarness()
  try {
    await f.service.command(createThread(), user)
    await Promise.all([f.runtime.reconcile(), f.runtime.reconcile()])
    const view = await f.service.query(user)
    expect(view.executions.filter(e => e.threadId === 't1')).toHaveLength(1)
    expect(f.registry.list()).toHaveLength(1)
  } finally { await f.close() }
})
```

- [ ] 运行目标测试确认 red。
- [ ] reconcile 自身串行化，步骤为读取状态→选择可运行 Thread→原子登记 queue+预算 reservation→准备环境和 profile→create/resume handle→记 start→驱动 runTurns。准备失败记 ended/blocked，不遗留预算。
- [ ] 关键驱动只由 runtime 调用：

```ts
try {
  for await (const event of agent.runTurns(controller.signal)) {
    observeExecutionEvent(execution.id, event)
  }
} finally {
  await agent.session.flush()
  await settleExecution(execution.id)
}
```

`observeExecutionEvent` 更新 live UI 缓冲与实际 usage；`settleExecution` 检查 Project 提交 intent/控制结果和 Session 结束事实，写 settled/end 并释放配额。两者在 execution.ts 实现；普通文本结束不能自行写 Thread completed。
- [ ] coordinator 单独保留执行配额，空闲不占 slot。依赖只有指定提交验收完成才满足。active Execution 的 pending inbox 也经调度限制驱动，不允许 followup 自动唤醒。
- [ ] 预算预留按调用输出上限与已知上下文保守计算，聚合全项目；未报告 usage 标 unknown并保留保守预留，绝不计零。项目时间预算与重试/返工上限触发 blocked；取消/暂停期间不派新活。
- [ ] 补测试：worker池满仍能处理 coordinator；DAG 解锁；pause 后提交迟到不启动下游；线程取消 generation 栅栏；未知 usage；prepare失败释放资源；dispose 等待手动驱动停止。
- [ ] 目标测试与 typecheck 通过提交 `feat(project-runtime): schedule bounded thread executions`。

## Task 10：协作工具、Coordinator 与持久消息投递

**Files:** 创建 `tool-project/package.json`、README、`src/{coordinator,worker,index}.ts`、`test/tools.test.ts`；创建 `project-runtime/src/delivery.ts`、`test/collaboration.test.ts`；profiles.ts 增加内置角色 prompt。

**Consumes:** Task 09 的 Runtime 与 Task 03 提交治理。
**Produces:** `projectCoordinatorTools`、`projectWorkerTools` 插件；`deliverOutbox(service,registry):Promise<void>`。两个工具插件 inject projects/tools，绑定可信 actor；不 import project-local。

- [ ] 用真实 scoped ToolsService 测试越权提交：

```ts
it('rejects a worker reviewing its own submission', async () => {
  const f = await makeToolHarness('worker')
  try {
    expect(f.tools.has('thread_review')).toBe(false)
    await expect(f.tools.execute('thread_review', {
      threadId: 't1', submissionId: 's1', verdict: 'accept', reason: 'done',
    })).rejects.toThrow('tool not found')
  } finally { await f.close() }
})
```

`makeToolHarness(role)` 在 tools.test.ts 用真实 project-local、ToolsService 和对应工具插件构造，测试不经 runtime 动态调度；tools 为 scope内注册表。
- [ ] 运行目标测试确认 red。
- [ ] Coordinator 安装 project_read、thread_create、thread_control、thread_message、thread_review、decision_record、request_user_input。Worker 安装 project_read、artifact_publish、thread_report、thread_submit。严格 schema 拒绝调用者提供 actor、grant 或 sourceRoot。
- [ ] thread_report payload 固定为 `{kind:'progress';text}`、`{kind:'blocked';reason;detail}` 或 `{kind:'decision';statement;rationale;evidence}`。进度不唤醒 coordinator；另外两类生成 outbox。
- [ ] 每个工具 commandId 由 Session+turn+step+callId+operation 派生；给 ToolExecuteOptions 增加可信 turn/step 坐标传递，模型没有这些字段的控制权。
- [ ] 源命令与 outbox 在同条 Project commit 记录；delivery 先 receiveOnce，再 session.flush，最后用新增 runtime 命令 outbox/delivered（deliveryId、sessionId、receipt）确认。合并 coordinator 通知的 revision 范围，去重不删除业务事实。
- [ ] 配置 coordinator system 明确：只引用可用 profile；为每个 Thread 给验收条件；收到 worker 结果读取证据再判断；不把模型最终回复当验收。worker system 明确发布产物与提交/阻塞协议，不能要求升级权限。
- [ ] 用 scripted fake LLM 跑“调研 + 基准并行→实现→审查”；按工具 schema执行真实命令。测试源提交后重投只入队一次、格式补充最多一次、没有递归 spawn、工具结果进入模型仍用 renderToolResult。
- [ ] 测试通过提交 `feat(project): coordinate workers through durable tools`。

## Task 11：恢复、暂停取消与宿主组合

**Files:** 创建 `project-runtime/src/recovery.ts`、`test/recovery.test.ts`；创建 `packages/cli/src/project-runtime.ts`、`project-host.ts` 和 `test/project-host.test.ts`；更新 CLI package 依赖。

**Consumes:** Tasks 07–10。
**Produces:** `composeProjectHost(options):Promise<ProjectHost>`（组合层）；`ProjectHostPool.open(workspace,id):Promise<ProjectHost>`、`closeAll():Promise<void>`。

ProjectHost 接口定义在 project-runtime：service:ProjectService、runtime:ProjectRuntimeHandle、sessionView(executionId):Promise<ExecutionTranscript>、subscribeSession(executionId,cursor,signal):AsyncIterable<SessionUpdate>、close():Promise<void>。ExecutionTranscript 包含 sessionId、events、running；SessionUpdate 是 durable event 或临时 assistant stream 的判别联合。sessionView 通过 registry 活跃实例读取，未加载时用只读 reader；不得用第二个 SessionLog writer 打开活动 Session。

ComposeProjectHostOptions 包含 workspace、projectId、profileResolver、environmentFactory、limits 和初始 Project 配置（创建时）；model配置解析只在这里读 System Config。environmentFactory 使用 Task 07 的三个方法；Eval 可注入安全临时环境。Pool 对并发 open 使用 single-flight Promise。

- [ ] 写恢复不自动重放未知工具的测试：

```ts
it('blocks interrupted side effects instead of rerunning them', async () => {
  const f = await makeRecoveryFixture('after-tool-side-effect')
  try {
    const host = await f.reopen()
    const view = await host.service.query(user)
    expect(view.threads.find(t => t.id === 't1')?.blocked?.reason).toBe('recovery')
    expect(f.externalWriteCount()).toBe(1)
  } finally { await f.close() }
})
```

`makeRecoveryFixture(cut)` 在 recovery.test.ts 使用真实日志和子进程 fixture；cut 枚举 after-source-commit、after-inbox-sync、after-claim、after-tool-side-effect、after-submit-commit。进程写 marker 后由测试强制结束，重开同目录；不只调用 graceful close 冒充崩溃。
- [ ] 运行目标测试确认 red。
- [ ] recover 先持锁读 Project，再校验 Session 格式和未闭合结束；active Execution 按证据转 interrupted、submitted 或明确可恢复入队。read-only 自动重试必须有配置、预算和次数上限；默认 unknown side-effect 等用户决定。
- [ ] 新增 runtime 命令 execution/recover（executionId、strategy:continue-safe|new-execution|leave-blocked，用户允许的策略由 runtime校验）。已接纳输入不能重新注入；未接纳输入从 receipt恢复；dispose 清空 inbox 前保留 Project可恢复事实。
- [ ] 实现 closeAll：先停止新命令/调度，停止 stream订阅，等待活动工具收尾，sync状态，再 dispose scopes和释放锁。Project pause保留记录，archive显式停止 coordinator和全部未完成 work，均不删产物。
- [ ] Pool key为 canonical Workspace+projectId，防止两个目录同 id串用；异常open清理缓存。credentials解析可更新引用，但固定 profile 的路由配置不能静默换模型。
- [ ] 全部故障切点与多host测试通过、typecheck后提交 `feat(project-runtime): recover hosts without replaying side effects`。


## Task 12：HTTP 命令、项目流与 Execution 读取

**Files:** 创建 `packages/cli/src/project-routes.ts`、`project-stream.ts`、`test/project-web.test.ts`；修改 server.ts；完成 `project/src/protocol.ts`。更新 CLI/Web package依赖。

**Consumes:** Task 11。
**Produces:** 下列 HTTP 契约。workspace query必须属于宿主已注册目录；id仅允许字母、数字、下划线和连字符，最多128字符。body验证从 unknown开始，不靠断言。

| 方法/路径 | 请求或响应 |
| --- | --- |
| GET /api/projects?workspace | ProjectSummary[] |
| POST /api/projects?workspace | CreateProjectRequest → ProjectView；创建 coordinator Thread、配置快照和 grant |
| GET /api/projects/:id?workspace | ProjectView |
| POST /api/projects/:id/commands?workspace | 用户允许的 ProjectCommand → CommandReceipt |
| GET /api/projects/:id/events?workspace&afterRevision | SSE ProjectUpdate |
| GET /api/projects/:id/executions/:executionId?workspace | ExecutionTranscript |
| GET /api/projects/:id/executions/:executionId/events?workspace&afterSeq | SSE SessionUpdate，含重连快照 |
| GET /api/projects/:id/artifacts/:artifactId/:revision/content?workspace | 验证归属后流式读取，安全 Content-Type/Disposition |
| GET /api/project-profiles?workspace | 可用 role/bundle 和无密钥模型选项 |
| PUT /api/projects/:id/profiles/:profileId?workspace | 新 profile 配置 → 新版本引用；不改活动 Execution |

CreateProjectRequest = commandId、name、goal、coordinatorModelRouteId、workerProfiles、grant、limits、sourceSelection。profile配置按批准的bundle目录验证，不接受任意模块地址。ProjectSummary = id/name/workspace/status/updatedAt/attentionCount。

ProjectView扩充：project、projectRevision、threads:ThreadRecord[]、executions:ExecutionRecord[]、profiles（无密钥）、decisions、artifacts、submissions、approvals、userInputs、integrations、usage、actions。actions按目标对象返回允许的用户动作；服务端仍独立鉴权。

```ts
export type ProjectUpdate =
  | { type: 'project'; projectId: string; revision: number; view: ProjectView }
  | { type: 'resync-required'; projectId: string; revision: number }
```

第一期每次项目业务提交发送安全快照，可合并短时间内变更；项目流不携带token。revision使用该快照真实revision，不能用旧commit revision标记新快照。前端使用 type-only domain导入；运行时校验导出自浏览器安全的 `@tnega/project/protocol`，该模块不得导入core或Node。

- [ ] 启动真实HTTP server+fake profile resolver，测试SSE断连后任务仍可提交。WebServerOptions新增可选projectHostFactory（受信库配置，HTTP不可设置），测试注入使用真实composeProjectHost和fake adapter。
- [ ] 首个HTTP安全测试：

```ts
it('rejects a browser request pretending to be the runtime', async () => {
  const f = await makeProjectWebFixture()
  try {
    const response = await fetch(f.commandUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tnega-client': '1' },
      body: JSON.stringify({
        commandId: 'attack', expected: [], type: 'execution/start',
        executionId: 'e1', actor: { kind: 'runtime' },
      }),
    })
    expect(response.status).toBe(403)
  } finally { await f.close() }
})
```

`makeProjectWebFixture` 在测试文件创建注册的临时Workspace和Project，再返回server与commandUrl；close关闭SSE读者、server和fixture。
- [ ] 运行目标测试确认red。
- [ ] 路由解析后绑定 user actor；保持x-tnega-client、JSON content-type和现有跨站校验。错误映射固定：输入400、权限403、不存在404、revision/锁冲突409、待恢复/配置不完整422、内部500；响应包含稳定code和安全message，不泄漏凭据。
- [ ] 命令与订阅分离。SSE close仅abort订阅signal，不操作Agent。关键handler：

```ts
const subscription = new AbortController()
res.once('close', () => subscription.abort())
for await (const update of projectUpdates(host, afterRevision, subscription.signal)) {
  writeProjectSse(res, update)
}
```

`projectUpdates` 在project-stream.ts先注册可追赶watch再输出对应快照；`writeProjectSse` 设置id=revision、event类型和JSON data，并处理背压。慢客户端超过有界缓冲则发送resync-required并关闭，不积压无限内存。
- [ ] Session流先发送durable transcript及当前临时stream快照；后续按seq和attempt/revision去重。重启后丢弃旧临时attempt，重新读取durable事实；没有最终消息的尝试不能假装成功。
- [ ] server.close先关闭项目订阅和停止HostPool，再等待HTTP server完成关闭，避免长期SSE让close永久等待。已有普通Session连接也要纳入收尾，保持取消语义不变。
- [ ] 补测试：断线追赶、snapshot/subscribe竞态、跨Project Session/Artifact访问拒绝、审批重连、重复commandId、目录越界、同时close、已有web.test.ts回归。
- [ ] 测试/typecheck通过提交 `feat(cli): expose durable project APIs and streams`。

## Task 13：前端 API、状态仓库与可恢复订阅

**Files:** 创建 `apps/web/src/project/api.ts`、`state.ts`、`useProject.ts`、`selection.ts`、`fixtures.ts` 和对应 `api.test.ts`、`state.test.ts`、`selection.test.ts`、`useProject.test.ts`。修改web/package.json，加入workspace project依赖。

**Consumes:** Task 12 protocol。
**Produces:** `projectApi`（list/create/get/command/watch/transcript/watchTranscript/readArtifact/listProfiles/publishProfile）；`useProject(key:ProjectKey|null):ProjectController`。ProjectKey=workspace+projectId。Controller包含view、connection(connecting/live/reconnecting/offline)、error、pendingCommandIds、send(command)、refresh()；所有异步结果绑定key/generation。

```ts
export type NavigationSelection =
  | { kind: 'session'; workspace: string; sessionId: string }
  | { kind: 'project'; workspace: string; projectId: string;
      threadId: string | null;
      panel: 'overview' | 'thread' | 'artifacts' | 'decisions' | 'settings' }
export interface ProjectClientState {
  key: { workspace: string; projectId: string }
  revision: number
  view: ProjectView | null
}
```

- [ ] fixtures导出 `projectView():ProjectView`（Demo项目、coordinator主Thread、Research worker、空其余集合、合法profile/usage/actions）；`projectUpdate(revision):ProjectUpdate`；禁止生产代码导入fixtures。
- [ ] 写旧事件不覆盖新状态测试：

```ts
it('ignores a late project snapshot', () => {
  const state: ProjectClientState = {
    key: { workspace: '/fixture', projectId: 'p1' },
    revision: 12, view: projectView(),
  }
  expect(applyProjectUpdate(state, projectUpdate(11))).toBe(state)
})
```

`applyProjectUpdate(state,event):ProjectClientState` 在state.ts实现，projectId不匹配、revision不增返回原对象；resync-required保持旧view并由controller重新取snapshot。
- [ ] 运行四份目标测试确认red。
- [ ] API用fetch读取SSE，保留x-tnega-client；解析跨chunk UTF-8、多行data、注释心跳与event id。JSON先validateProjectUpdate，类型错误显示协议错误并重取；不new EventSource绕过header。
- [ ] useProject先GET，再watch(afterRevision)；断开后带游标重连，指数退避最大10秒，组件卸载清除timer和abort订阅。HTTP/解析错误不能转换成“项目已完成”。
- [ ] send生成并保留commandId，网络结果未知时重试用同id；409获取新快照并要求用户重新判断，不能盲目修改expected revision自动覆盖。输入草稿只在确认提交后清空。
- [ ] 导航保存到 `tnega-navigation-v2`，首次读取可从现有workspace/session选择迁入；切换目标立即取消旧请求，但不发任务取消命令。
- [ ] 补测试：切换同id不同workspace不串消息；A迟到响应不覆盖B；重复SSE无重复卡片；卸载不再发请求；断线保留草稿；未知命令结果重试id稳定。
- [ ] 运行目标测试、`pnpm --filter @tnega/web typecheck`；提交 `feat(web): add reconnectable project state`。

## Task 14：Project 导航、创建和角色配置入口

**Files:** 创建 `project/ProjectNav.tsx`、`CreateProjectDialog.tsx`、`ProfileFields.tsx` 和 `navigation.test.ts`、`create.test.ts`；修改 `App.tsx`、`workbench/WorkspaceSidebar.tsx`、`WorkspaceTree.tsx`、`App.test.ts`、`workbench/workbench.test.ts`。

**Consumes:** Task 13 selection/controller/API与现有getConfig。
**Produces:** 每个Workspace下明确的Projects和Sessions分组；创建成功进入Project。ProjectNav props为projects、selectedProjectId、onSelect、onCreate；CreateProjectDialog props为workspace、open、onOpenChange、onCreated，内部通过projectApi加载批准的profiles和model routes。

- [ ] 在jsdom测试创建必填校验：

```ts
it('requires a goal before creating a project', async () => {
  const onCreated = vi.fn()
  render(createElement(CreateProjectDialog, {
    workspace: '/fixture', open: true, onOpenChange: vi.fn(), onCreated,
  }))
  fireEvent.change(await screen.findByLabelText('Project name'), {
    target: { value: 'Search quality' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
  expect(await screen.findByText('Enter a project goal.')).toBeTruthy()
  expect(onCreated).not.toHaveBeenCalled()
})
```

测试fixture拦截profile catalog并返回已有route，保证失败原因是缺goal而非网络或模型缺失。
- [ ] 运行目标测试确认red。
- [ ] App增加NavigationSelection分支；保留普通Session读写代码，ProjectView单独挂载。把原来指Workspace的“Projects”标签改为“Workspaces”；工作区内部再出现真实Projects，按钮aria-label包含完整对象类别。
- [ ] 创建表单包括name/goal、源Workspace、Coordinator模型、每种worker的模型、权限preset、并发与token预算。model选项只来自系统配置；无route时给Open settings，保留表单。
- [ ] 脏Workspace返回SOURCE_SELECTION_REQUIRED时展示已提交版本与选择文件快照两种明确操作；展示manifest，不自动忽略未提交文件。创建错误保留值；同commandId防重复点击创建。
- [ ] profile第一版从已批准role模板选择，显示工具范围；不提供任意JavaScript/MCP模块输入框。创建后保存不可变profile版本。
- [ ] 补测试：刷新恢复Project选择、删除/撤销Workspace访问回到空态、两个同名Project可区分、键盘打开关闭dialog、Escape焦点回按钮、普通Session仍可创建与切换。
- [ ] Web typecheck及相关回归通过提交 `feat(web): create and navigate collaboration projects`。

## Task 15：Project 总览与主会话

**Files:** 创建 `project/ProjectView.tsx`、`ProjectOverview.tsx`、`ProjectChat.tsx`、`ProjectComposer.tsx`、`ThreadCard.tsx`、`overview.test.ts`、`chat.test.ts`；新增 `workbench/ComposerSurface.tsx` 并由现有ComposerFrame复用其纯布局；修改App.tsx与styles.css。

**Consumes:** Task 14，现有Transcript/ToolActivity/Session投影。
**Produces:** ProjectView({workspace,projectId,onSelectThread})；ProjectChat({controller,threadId})。ComposerSurface只接收children/accessory/footer/disabled，不了解Auto/Plan/Goal或模型调用；旧ComposerFrame保留原功能，ProjectComposer展示固定profile与线程输入。

- [ ] 测试导航离开不取消项目：

```ts
it('does not cancel work when the project view unmounts', async () => {
  const cancelRequests: string[] = []
  const transport = mockProjectTransport(cancelRequests)
  const view = render(createElement(ProjectView, {
    workspace: '/fixture', projectId: 'p1', onSelectThread: vi.fn(),
  }))
  await screen.findByRole('heading', { name: 'Demo' })
  view.unmount()
  expect(cancelRequests).toEqual([])
  expect(transport.activeSubscriptions()).toBe(0)
})
```

`mockProjectTransport(cancelRequests)` 在chat.test.ts提供fetch响应与可关闭ReadableStream，记录thread/cancel/project/control命令；它不替代服务器运行，只检验组件生命周期。
- [ ] 运行目标测试确认red。
- [ ] 总览顶部展示name/goal、连接状态和预算；中心为Coordinator对话，任务区按Needs attention、In progress、Ready for review、Completed分组。任务卡显示Thread状态与当前Agent活动，不能以idle判断完成。
- [ ] 用Execution transcript API+独立stream渲染主会话。复用MessageBlock等展示组件，不复用ChatView发起run的逻辑。project_read工具结果以现有ToolActivity展示。
- [ ] 发送消息使用thread/message；发送中允许保留输入草稿，失败可以用同commandId重试。断线时显示Reconnecting，已有内容保留，不把“未连接”显示成“已暂停”。
- [ ] ThreadCard关键渲染保持语义可读：

```tsx
<article aria-label={thread.title}>
  <button type="button" onClick={() => onSelect(thread.id)}>
    {thread.title}
  </button>
  <span>{threadStateLabel(thread)}</span>
  <span>{activityLabel(execution)}</span>
</article>
```

`threadStateLabel(ThreadRecord):string`、`activityLabel(ExecutionRecord|null):string` 在state.ts定义纯投影；未知/未加载activity显示Not running或Unavailable，不能输出完成。
- [ ] 补测试：空Project引导、消息流增量最终去重、两个worker可并行显示、普通进度不重复主会话、错误局部显示、窄屏任务区可折叠。
- [ ] Web typecheck、目标测试和原composer/workbench回归通过提交 `feat(web): render project overview and coordinator chat`。

## Task 16：Thread 详情、执行历史与人工介入

**Files:** 创建 `project/ThreadDetail.tsx`、`ExecutionHistory.tsx`、`ThreadActions.tsx`、`thread-detail.test.ts`；修改ProjectView及selection。

**Consumes:** Task 15；revision命令与Execution transcript。
**Produces:** ThreadDetail({controller,threadId,onBack})；可查看历史Execution、发送要求、修改目标、取消、重开、申请重试和改派profile。

新增用户命令 `thread/reassign` payload=threadId/profile:ProfileRef/reason；它提升taskRevision，要求旧execution静止后新建执行。取消、改派与目标重大变化都由runtime完成栅栏切换，前端不能自己选择executionId接管。

- [ ] 测试旧目标的响应不能覆盖新选择：

```ts
it('keeps the selected execution when an older fetch completes', async () => {
  const f = mockThreadHistory()
  render(createElement(ThreadDetail, {
    controller: f.controller, threadId: 't1', onBack: vi.fn(),
  }))
  fireEvent.click(await screen.findByRole('button', { name: 'Execution 2' }))
  await screen.findByText('Second execution result')
  await act(async () => { f.resolveFirst() })
  expect(screen.queryByText('First execution result')).toBeNull()
})
```

`mockThreadHistory` 在测试内创建2个execution与延迟Promise，controller结构按Task13完整实现；返回resolveFirst控制时序。
- [ ] 运行目标测试确认red。
- [ ] 展示goal、acceptance、依赖链接、profile@version、taskRevision、状态及阻塞原因；旧Execution只读，当前Execution可发送补充。
- [ ] 运行中补充采用steer，空闲采用followup；修改goal使用thread/revise，不把大改向伪装成聊天。操作携带Thread revision，409保留草稿并显示服务器新要求，用户再次确认后创建新commandId。
- [ ] Cancel只影响目标Thread，下游显示Dependency blocked；Retry进入新Execution，未知副作用先显示恢复核对事项；Reopen保留旧验收记录。
- [ ] 用户直接介入Worker后，主会话显示已介入的项目活动；不把旧Execution的模型/工具改成新profile。活动execution的模型选择只读，改派必须创建新版本工作。
- [ ] 补测试：取消并非关闭drawer、不同execution分别加载、失效artifact/decision依赖提示、重开completed、profile变更不污染旧历史、用户要求在Coordinator可见。
- [ ] 通过测试和Web typecheck后提交 `feat(web): inspect and steer thread executions`。

## Task 17：决策、产物版本与验收界面

**Files:** 创建 `project/DecisionPanel.tsx`、`ArtifactLibrary.tsx`、`ArtifactPreview.tsx`、`SubmissionReview.tsx`、`delivery.test.ts`；更新ProjectView/styles。

**Consumes:** Task 03/07/12，Task16的Thread导航。
**Produces:** 按类型与生产Thread过滤的Library、Decision proposed/accepted/superseded视图、提交审查入口。组件通过ProjectController.send执行既定命令。

- [ ] 测试验收绑定实际revision：

```ts
it('reviews the displayed submission instead of the latest unseen revision', async () => {
  const f = reviewFixture()
  render(createElement(SubmissionReview, {
    controller: f.controller, threadId: 't1', submissionId: 's1',
  }))
  fireEvent.click(await screen.findByRole('button', { name: 'Accept submission' }))
  expect(f.sent()).toContainEqual(expect.objectContaining({
    type: 'thread/review', threadId: 't1', submissionId: 's1', verdict: 'accept',
  }))
})
```

`reviewFixture` 在delivery.test.ts返回完整view，其中s1引用artifact a1@1；send记录命令并返回receipt，后续推s2测试用户当前审查不被偷偷切换。
- [ ] 运行目标测试确认red。
- [ ] Library显示artifact版本、生产Thread/Execution、上游引用与验收证据；可下载历史revision。Markdown使用现有react-markdown安全渲染，代码/HTML以文本显示；不执行产物脚本，不直接接受任意本机path。
- [ ] Decision支持提出建议、接受指定revision和查看替代关系；冲突建议并列。采纳后显示影响的Thread，不能最后写入覆盖前一决定。
- [ ] SubmissionReview显示要求与证据，Accept仅发验收；Request changes必须有reason。代码增加独立Integrate action，显示目标commit和集成验证结果；不与Accept/push合并。
- [ ] 避免 UI 乐观标 completed：必须等receipt和新ProjectView。过期revision/不存在blob/集成冲突显示可操作错误，保留审阅位置。
- [ ] 补测试：XSS文本不执行、旧artifact内容不变、跨Project下载拒绝错误、验收不触发集成、集成未验证不显示交付成功、缺证据引导返工。
- [ ] 通过测试和Web typecheck后提交 `feat(web): review versioned decisions and deliverables`。

## Task 18：审批、项目控制、预算与恢复 UX

**Files:** 创建 `project/AttentionPanel.tsx`、`ApprovalCard.tsx`、`RecoveryPanel.tsx`、`ProjectSettings.tsx`、`attention.test.ts`、`settings.test.ts`；更新ProjectView/styles。

**Consumes:** Task 08/11和服务端actions字段。
**Produces:** 项目级待处理入口，显示审批、用户问题、预算阻塞及恢复核对。Settings支持limits、grant收紧/撤销、后续Execution的profile新版本；提高授权明确显示差异。

新增用户命令 `project/configure` payload=limits与grant；新版本对后续实际调用生效，活动profile保持版本固定。limits收紧后不启动新工作，超过新上限的现有工作按pause策略收尾，不伪造已退回的实际费用。

- [ ] 测试断线后审批仍显示并防止重复提交：

```ts
it('shows pending approval after reconnect and submits once', async () => {
  const f = attentionFixture()
  render(createElement(AttentionPanel, { controller: f.controller }))
  const button = await screen.findByRole('button', { name: 'Approve once' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(f.commands().filter(c => c.type === 'approval/decide')).toHaveLength(1)
})
```

`attentionFixture` 在测试内提供pending approval和尚未resolve的send Promise，让重复点击测试在pending期间进行。
- [ ] 运行目标测试确认red。
- [ ] ApprovalCard显示哪个Thread、工具、脱敏参数、范围与到期时间；Approve once/Reject附approval revision，pending期间disabled。已过期/消费改为只读结果，重连不重新生成批准。
- [ ] 项目Pause、Resume、Archive与Thread Cancel分开。标题/提示明确“宿主运行期间后台继续”；退出应用会停止本机执行，重启需要恢复，不承诺关机继续。
- [ ] RecoveryPanel显示可能已发生的副作用、Session/工具证据，提供继续安全工作、新建Execution或保持阻塞；任何选择均由服务端重新验证。不能提供无条件“全部重跑”。
- [ ] Budget显示已用、预留和未知usage；unknown显示Unknown，不转0。预算耗尽时用户可以明确提高上限、取消或保留阻塞，不能自动扩大。
- [ ] 样式复用主题变量，桌面主区域+侧面详情，<=760px用可关闭drawer。所有状态有文字；错误区域role=alert，进度aria-live=polite，键盘焦点可返回触发按钮。
- [ ] 补测试：权限撤销后旧审批失效、批量项目pause后无新run、未知成本、重启recovery事项、可访问键盘导航、dark/light和窄屏布局无内容遮挡。
- [ ] 通过相关UI测试及Web typecheck后提交 `feat(web): handle project approvals and recovery`。


## Task 19：接入 Eval，记录完整协作证据

**Files:** 创建 `packages/eval/src/projectRuntime.ts`、`packages/eval/test/projectRuntime.test.ts`；修改 `packages/eval/src/types.ts`、`runner.ts`、`index.ts`、包依赖及相邻 runner 测试；在 CLI eval composition 注入 Task 11 的 host factory。

**Consumes:** Task 11 的 ProjectHostFactory 和持久事件；不依赖 HTTP 或 UI。
**Produces:** 单 Agent 与 Project 可使用相同 Task/check 验收，Project 运行包含所有 worker 的证据和费用。

在 types.ts 增加可选 `EvalRunOptions.project: ProjectEvalConfig`；与 coding 配置互斥，启动时校验。ProjectEvalConfig 包含 hostFactory、serializableConfig 和 completionPolicy。factory 不进入 cache hash，serializableConfig 必须包含 factoryVersion、profileHash、模型路由版本、工具版本、权限、环境快照及预算。completionPolicy 限制截止时间、最大调度次数和未解决审批的处理；CI 默认将未解决审批记作 blocked，不自动批准。

`runProjectTrial(config, task, signal)` 返回 `ProjectTrialResult`，包含 evidence、usage、terminalReason。Evidence 新增可选 project 字段：projectId、Project Log 引用、Execution 到 Session 的映射、决策/产物版本、验收记录；不把多个 worker 的消息拼成一条虚假的 Agent Session。项目统计的 tokens/cost 分别包含 known、unknownExecutions、reserved；缺少 provider usage 时不能当作实际零费用。

- [ ] 在 projectRuntime.test.ts 创建 `projectEvalFixture`，复用 Task 09 scripted LLM/真实 store 和 Task 11 host factory。夹具返回 config/task，并让 coordinator 与两个 worker 分别产生 10、20、30 个 token；固定所有价格元数据。
- [ ] 编写失败测试：

```ts
it('includes coordinator and worker usage in project evidence', async () => {
  const f = await projectEvalFixture()
  try {
    const result = await runProjectTrial(
      f.config, f.task, new AbortController().signal,
    )
    expect(result.usage.tokens.known).toBe(60)
    expect(result.usage.tokens.unknownExecutions).toEqual([])
    expect(result.evidence.project?.executions).toHaveLength(3)
    expect(result.terminalReason).toBe('completed')
  } finally {
    await f.close()
  }
})
```

- [ ] 执行 `pnpm test -- packages/eval/test/projectRuntime.test.ts` 确认功能 red。
- [ ] runner.ts 加 project 分支：有 project 时不安装普通 candidate plugin；创建隔离 trial workspace、调用 runProjectTrial、收集 evidence，再调用原 strategy registry。不能经普通 _runTask 再调用一次模型。
- [ ] runner budget 汇总计入所有 Execution。保留旧 BudgetUsage 数字字段兼容既有读取方，同时增加可选 completeness 元数据；项目未知费用不可据旧数字断言未超预算。运行时继续以预留上限阻止超额 admission。
- [ ] runProjectTrial 用 try/finally 关闭 host；超时、取消和 check 失败均保存已持久证据。将 host 的最终状态映射为 completed、blocked、cancelled、failed，不由最后一条自然语言推断成功。
- [ ] 使用相同 Task、初始代码、模型配置和总预算比较单 Agent / Project：成功率、费用、墙钟时间、返工次数、未验收输出和恢复成功率。比较结果允许 Project 更差，不把并行数量当质量指标。
- [ ] 补测试：未知 cost 标记、失败 worker 计费、超时清理、profile 版本改变使 cache miss、恢复不重复计数、普通 coding/agent eval 兼容。真实模型实验放 opt-in，CI 不需要 API key。
- [ ] 执行相关 eval 测试和 `pnpm typecheck`；提交 `feat(eval): evaluate project collaboration traces`。

## Task 20：贯通 UI、Desktop 与发布入口

**Files:** 创建 `packages/cli/test/project-e2e.test.ts`、`apps/web/src/project/flow.test.ts`；更新根 `package.json`、`scripts/build.mjs`、`src/index.ts`、`src/services.ts`、对应发布测试和包 README；更新 `CONTEXT.md`、设计稿状态与用户文档。Desktop 仅在宿主关闭接线确需变动时修改 `apps/desktop`，先遵循其 AGENTS.md。

**Consumes:** Task 01–19。
**Produces:** 用户从创建到交付可完成整个流程，发布包可导入新插件，Web 与 Desktop 使用同一实现。

- [ ] 后端贯通测试使用真实 HTTP server、临时 Git 仓库、真实 Project/Session 持久化和 scripted LLM。场景：创建 Project → coordinator 分配两个依赖任务 → worker 请求审批 → 浏览器断线 → 重新订阅并批准 → worker 提交产物 → 验收 → 独立集成 → 重启回放。断言每次外部副作用只执行一次，未验收产物不会自动进入目标分支。
- [ ] UI flow.test.ts 使用真实组件与受控 API transport，验证创建表单、导航、主会话、任务详情、审批、产物审阅和恢复；按 Task 13 fixture 契约实现 `projectFlowFixture`，返回 mount、server、commands、close，server 能推送严格符合协议的 ProjectView 与 Session Event。测试观察 DOM 和命令，不直接修改组件内部 state。
- [ ] 先运行两个目标测试确认功能 red；完善 composition、路由和组件接线直到通过。不得仅 mock 掉调度器后宣称完成后端贯通。
- [ ] 根 exports / build entry points 加 `project`、`project-local`、`project-runtime`、`tool-project` 及 `project/protocol`；更新 packageDirs 与类型入口。protocol 子路径仅导出浏览器可用类型和校验器，不间接加载 node:fs、Provider 或 service 初始化副作用。
- [ ] 发布测试验证所有新入口可解析、类型文件齐全、protocol 可被 Web bundler 使用；普通导入不创建目录、不启动 Agent。
- [ ] 宿主关闭先断开订阅，再停止调度、取消/收尾 active run、flush logs、dispose Fiber、关闭 server；不要等待永不结束的 SSE 才开始清理。Desktop 退出复用这一路径，不新建一套 IPC scheduler。
- [ ] 实际浏览器手工走一遍以上用户流程，另外检查双标签页、刷新、空项目、错误模型配置、审批过期、409 冲突、窄屏和键盘导航。记录实际验证日期、环境与结果；未执行项明确标注，不能用 jsdom 代替视觉确认。
- [ ] Desktop smoke：启动 → 创建 Project → 审批挂起 → 退出 → 重启 → 查看恢复事项。确认退出后没有遗留子进程，重启不自动重放不确定的写操作。
- [ ] 最终执行 `pnpm typecheck`、`pnpm exec tsc -p apps/web/tsconfig.json --noEmit`、`pnpm lint`、`pnpm test`、`pnpm test:package`。先检查 test:package 是否已调用 build；若未包含则先 `pnpm build`。改到 Desktop 时追加该目录文档要求的检查。仅文档计划提交阶段不运行这些尚不存在功能的测试。
- [ ] 将实现中实际采用的协议、格式迁移、配置例子和恢复限制写入 README/CONTEXT，更新设计稿与本计划状态；保留每个任务的真实测试记录。
- [ ] 验证通过后提交 `feat(project): ship collaboration across web and desktop`。

## 实施补充：跨任务契约校准

以下约束优先用于实现，避免任务之间各自定义相近类型：

- 可序列化 WorkerProfile / ProjectGrant / ProjectLimits 在 Service Definition 中拥有；runtime 只拥有 CompiledProfile 和具体能力装配。Definition 不 import runtime。
- Profile 保存统一使用用户命令 `profile/publish`，payload 为完整 WorkerProfile 和 expectedProfileVersion；ProjectState 保存版本化 profile 描述。HTTP PUT 只是命令适配，不能绕过 Project Log 直接修改运行中 profile。
- 恢复分为用户命令 `thread/recover`（threadId、expectedExecutionId、strategy、reason）和 runtime 内部 `execution/recover`。用户提出选择，runtime 验证 Session 证据后推进；UI 不具备伪造 execution 状态的权限。
- Task 08 的实际审批匹配对象必须完整提供 executionId、generation、grantRevision、now、tool、argumentHash、environmentId。测试中用相同固定值构造 record 和 call，再只改变 argumentHash，不能省略生产函数必需字段。
- 每个命令的 role、payload、revision 校验和 receipt 都归 Definition；HTTP 与模型工具只做身份绑定和数据验证。Agent 不能传入 actor、grant 或可信环境路径来提高自身权限。
- Test fixture 是对应任务必须实现的测试代码，不是仓库已有 API。示例体现关键断言；测试辅助方法必须通过公开接口驱动系统，故障注入只能位于明确 I/O 边界。
- Task 19 在现有 EvalRunner 上增加 project 路径；共享的是注入的 host factory，不让 eval 反向依赖 CLI。UI、CLI composition 和 eval adapter 的依赖方向保持一致。

## 验收覆盖

| 用户关心的问题 | 实施位置 | 完成判据 |
| --- | --- | --- |
| Thread 抽象和 Agent 状态 | 01、04、05、09、11、16 | 状态可回放；一个 Thread 无重复活动执行；详情区能解释等待原因 |
| Agent 如何协调 | 09、10、11、15 | 依赖调度、定向消息、提交/返工、重投和取消形成闭环 |
| 决策和产物归属 | 03、07、17 | Project 持有版本，保留生产者；接受与集成是不同操作 |
| 父子模型和工具差异 | 06、08、10、14、16 | coordinator 工具精简；worker 独立配置；无隐式授权升级 |
| 插件放在哪一层 | 01、06、09、11、20 | runtime 位于 Loop 之上，各插件可卸载且无残留 |
| UI 是否完整 | 12–18、20 | 创建、导航、会话、详情、审批、验收、设置和恢复均可操作 |
| eval-first | 19 | 同任务同预算对比，记录所有执行证据及未知费用 |
| 下期能力演化 | 06、19 | 留下 profile 版本和评测证据；本期不自动生成或上线新能力 |

完成本期的标准是用户可以从 UI 创建并交付一个 Project，并能在中断后理解和恢复其状态。只完成后端并行调用，或只能观看无法审批/验收的 UI，都不算完成。
