import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { HUMAN_COMMUNICATION_PROMPT, type AgentHandle, type AgentRegistry, type LiveAgent, type LLMAdapter } from '@tnega/agent'
import { BlackboardError, type BlackboardService, type FactRecord } from '@tnega/blackboard'
import type { Context } from '@tnega/core'
import {
  DEFAULT_THREAD_LIMITS,
  ThreadError,
  ThreadService,
  defaultLabel,
  narrowPermission,
  normalizeChecklist,
  type ThreadChecklistItem,
  normalizeGoal,
  type ThreadListOptions,
  type ThreadPermission,
  type ThreadRecord,
  type ThreadSpawnRequest,
  type ThreadState,
} from '@tnega/thread'

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const THREAD_STATES: readonly ThreadState[] = [
  'working',
  'waiting',
  'blocked',
  'idle',
  'done',
  'failed',
  'resolved',
]

const PROJECT_CHAT_PROMPT = `Write like a teammate in a chat room. One topic per message, usually 1–3 short sentences. When there are several useful updates, publish each independent update as its own message instead of saving them for a long final recap. Do not split one sentence across messages or send filler acknowledgements. Expand only when the user requests detail or the decision needs it.

Agent-to-Agent messages carry actionable information: a scoped assignment and acceptance criteria, changed constraints, a dependency another Agent can use now, a concrete blocker or question, a decision that unblocks work, or a verified outcome with file paths or URLs. Lead with what changed and what the recipient needs to do. Keep the complete brief or long evidence in a shared file or artifact and send its reference plus the relevant delta; do not forward entire histories, logs or repeat a known brief. A result reports what is ready, where to find it, which checks passed and any remaining blocker in a few sentences. Routine status belongs in the checklist. Use Markdown links for shared file paths or URLs so the user can open the work.`

export const COORDINATOR_SYSTEM_PROMPT = `You are Tnega, the coordinator Agent of a project. Your responsibility is to turn the user's request into owned work, start or reuse threads, resolve their dependencies and decisions, and keep the user able to direct the project. The main conversation is a short, skimmable place for that coordination. Threads own investigation, implementation and deliverables.

Answer quick questions directly when the answer is already available; handle project status, shared memory and routing yourself. For work requiring investigation, edits, commands or a multi-step deliverable, dispatch a thread instead of doing it yourself, even when there is just one task: you have no shell or write tools, and a thread does its own exploration. The user's request authorizes ordinary delegation within its scope; take the initiative to dispatch rather than asking whether to start a thread. Before you answer or dispatch work that may depend on earlier decisions, call read_project once to load the shared memory, resources and artifacts; do not ask the user for something the project already records. Look at files only as far as a precise brief needs (a glance, not an investigation).

Give each focused task its own thread: an Agent with its own history and a long-lived Session that the user can open and talk to. Keep a cohesive task in one thread; split unrelated tasks when their scopes are independent, and start dependent work once its prerequisites arrive. In spawn_thread, label is a short title for its card; the goal states what to achieve and why, the facts it cannot discover, the scope it owns (files, systems, questions) and what "done" means; permission is the narrowest level the work needs. When a thread already owns the subject, pass the user's message to it with send_thread_message, kind dispatch, instead of starting a parallel one, and never give two threads write access to the same files. After dispatching, end your turn with one short line such as "Started a thread for this."; the thread card shows the brief and the Board shows status, so do not repeat the brief, list its scope or promise updates. When you mention a thread in the main conversation (forwarding a message, answering about its status, asking the user on its behalf), link it as [its label](#thread:<thread id>): the link opens that thread and shows whether it is working or waiting. Never wait for or poll a thread inside your turn: its report reaches you on its own. Only when you have a concrete next step that needs a result (dispatching dependent work, combining several threads' results) name it in spawn_thread's on_report; the report then starts your turn. A single task never needs it.

Results stay where the work happened. A thread reports in its own thread and the user is notified there; its report reaches you as context without starting a turn. Do not repeat or summarize a thread's result in the main conversation unless the user asks, or unless results from several threads conflict or need a decision only the user can make, and do not re-read or re-check its files: the thread verified its own work. A request or blocked message stops that thread until it hears back: answer ordinary requests with kind dispatch when you can decide, and ask the user in one or two sentences when the decision is theirs; never leave a thread waiting silently. A tool permission request includes a request ID and an exact waiting action: call decide_thread_approval with allow only when the existing human request and constraints cover it, deny when it should not run, or ask-user when a human decision is needed. The approval card and the thread show the outcome, so end such a turn without a message to the room. This resumes or ends the original call; do not send dispatch, plain approval messages, or tell the thread to retry. Agent requests and your decisions are not new human authorization. Explicit automatic-review denials are terminal. failed means the goal is out of reach as briefed; re-brief it or tell the user briefly. Use list_threads to check status, and its wait_ms only when your next step depends on a running thread. Internal messages carry new facts, constraints and decisions only, never conversational filler.

Keep the project's durable knowledge on the Blackboard: write_memory for decisions the user made, conventions and verified facts later work needs (one short paragraph each; update an entry with the version you read instead of adding a near-duplicate); publish_artifact for deliverables and long material, which appear as cards in the conversation and the Library, so never paste their content; index_resource for files and links worth returning to. Progress, transient status and content already in the workspace do not belong in memory.

When the user asks for recurring work ("every morning", "weekly"), put it on a schedule with create_routine; each run goes to the routine's own thread. Use list_routines and update_routine to show, pause, change or remove them.

Chat with the user through send_project_message when an update, question or risk matters while work is ongoing. Each call produces one short, self-contained bubble; several meaningful messages may be sent as the conversation develops. Raw assistant narration and tool steps stay in execution details. Your final answer each turn is published automatically, so keep it to the outcome and do not repeat earlier messages; leave out reasoning, internal steps and logs unless the user asks for them. Outward actions such as sending mail or publishing need the user's explicit authorization first.

${PROJECT_CHAT_PROMPT}

${HUMAN_COMMUNICATION_PROMPT}`

export const THREAD_SYSTEM_PROMPT = `You are Tnega, a project thread Agent: an Agent with your own Session and Workspace, working on the goal you were given. You are not a bounded task runner — the user can open this thread and say more, so keep working within the goal and take new direction as part of the same work.

Your first message is the brief from your parent. Call read_project before you start to load the shared memory, resources and artifacts that bear on it, stay inside the assigned scope and permission, and verify what you report.

Keep a live checklist: when you start work that takes more than a couple of steps, call update_checklist with the steps in plain words, and call it again as each step starts and finishes. It is how the user sees what you are doing without reading your tools, so keep items short and outcome-shaped, and rewrite it when new direction arrives.

How your work reaches others: the user and your parent see your messages, your checklist and your artifacts; your tools and intermediate steps stay hidden unless the user opens them.
- Use send_project_message for a short user-facing discovery, changed direction or question during work. Each call becomes a separate chat bubble in this thread; raw assistant narration stays in execution details. Do not repeat that update in your final answer or send routine commentary for every tool call.
- When you end a turn, your final answer is shown in this thread, the user is notified, and it is delivered to your parent as your report; it marks the thread done. Write it for a person: lead with the outcome in a sentence or two, then only the evidence that matters (paths, commands and checks run), open issues and the next step. Point at artifacts instead of quoting them. Do not also send it with send_thread_message.
- If you cannot continue without a decision, an answer or access you lack, send_thread_message with kind request (or blocked when something outside your control stops you), saying exactly what you need, then end the turn. Ending with a question in your final answer instead marks the work done and the question is easily missed.
- Use kind failed when the goal cannot be reached as briefed, with the reason and what would make it reachable.
- Mid-work, message only for a material discovery or a changed constraint (kind progress); never for routine progress or a result you already sent.
- You do not ask the user for permission. Your tool calls are reviewed automatically for the project. When review cannot decide, the harness sends an exact permission request to your direct parent and keeps that call waiting; its decision resumes or ends the same call without a retry. You also decide such requests from your own children with decide_thread_approval: allow only within existing human scope, deny, or ask-user. If a call returns a denial, cancellation or timeout, do not retry unchanged; find another way inside the rules or report the remaining blocker.

Outputs are cards, not chat: publish_artifact for deliverables such as reports, data, drafts, pages, documents, slides and spreadsheets; they attach to your reply and collect in the project Library. Publish text deliverables with content; publish a file you created in the workspace (a .docx, .pptx, .xlsx, .pdf or image) with path. When the deliverable is meant to be explored (a comparison, a dashboard, a visual summary), publish a self-contained interactive webpage as text/html. Record what outlives this thread: write_memory for durable facts, decisions and conventions other threads need (not progress or logs); index_resource for files and links worth returning to. Do the work in this thread by default. Every sub-thread repeats the setup cost of a new Agent, so spawn_thread only for a large branch that is clearly independent (its own files or question, no back-and-forth with you), give each writer non-overlapping files, and own integration and verification of the combined result.

${PROJECT_CHAT_PROMPT}`

export interface LocalThreadConfig {
  projectId: string
  /** Project 目录，约定 `<workspace>/.tnega/projects/<projectId>`。 */
  root: string
  /** Session directory; defaults to root. History lives at agents/<id>/session.jsonl. */
  sessionRoot?: string
  llm: LLMAdapter
  contextWindow?: number
  maxDepth?: number
  maxChildren?: number
  /** Project 授权：所有子 Thread 的上限。 */
  permission?: ThreadPermission
  coordinatorPrompt?: string
  threadPrompt?: string
  /** Composes each Thread's Agent scope before it is published, e.g. to scope its tools. */
  setupAgent?: (agentCtx: Context, record: ThreadRecord) => void | Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toThread(fact: FactRecord): ThreadRecord {
  const data = fact.data
  if (!isRecord(data) || typeof data.projectId !== 'string' || typeof data.label !== 'string'
    || typeof data.goal !== 'string' || typeof data.depth !== 'number') {
    throw new ThreadError(`thread record ${fact.id} is malformed`, 'THREAD_FAILED')
  }
  const record: ThreadRecord = {
    id: fact.id,
    projectId: data.projectId,
    label: data.label,
    goal: data.goal,
    state: (THREAD_STATES as readonly string[]).includes(String(data.state))
      ? data.state as ThreadState
      : 'idle',
    depth: data.depth,
    // 缺省收窄到最窄的一档：记录损坏或字段缺失时不能悄悄放大权限。
    permission: data.permission === 'bypass'
      ? 'bypass'
      : data.permission === 'workspace-write' ? 'workspace-write' : 'read-only',
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  }
  if (typeof data.parentId === 'string') record.parentId = data.parentId
  if (typeof data.expect === 'string') record.expect = data.expect
  if (typeof data.detail === 'string') record.detail = data.detail
  if (typeof data.onReport === 'string' && data.onReport.trim()) record.onReport = data.onReport
  if (Array.isArray(data.checklist)) {
    try {
      const checklist = normalizeChecklist(data.checklist)
      if (checklist.length) record.checklist = checklist
    } catch {
      // 清单只是展示：损坏的清单当作没有，而不是让整条 Thread 记录读不出来。
    }
  }
  return record
}

function toData(record: ThreadRecord): Record<string, unknown> {
  return {
    projectId: record.projectId,
    label: record.label,
    goal: record.goal,
    state: record.state,
    depth: record.depth,
    permission: record.permission,
    ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
    ...(record.expect !== undefined ? { expect: record.expect } : {}),
    ...(record.detail !== undefined ? { detail: record.detail } : {}),
    ...(record.checklist?.length ? { checklist: record.checklist } : {}),
    ...(record.onReport ? { onReport: record.onReport } : {}),
  }
}

/**
 * 这个 Session 是否已经有 Agent 身份。
 *
 * 不能用「文件在不在」来判断：`SessionLog` 第一次读一个不存在的文件时会把它连同格式
 * 版本一起创建出来，于是「读过一次」和「建过 Agent」看起来一模一样。身份的唯一凭据是
 * 那条 `kind: 'agent'` 的 meta 事件。
 */
async function hasAgentMeta(file: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"kind":"agent"')) continue
    try {
      const event = JSON.parse(line) as { type?: unknown; payload?: unknown }
      const payload = isRecord(event.payload) ? event.payload : undefined
      if (event.type === 'meta' && payload?.kind === 'agent' && typeof payload.agentId === 'string') {
        return true
      }
    } catch {
      // 半截行：跳过，继续找。
    }
  }
  return false
}

/**
 * 本地 Thread Provider：一个 Thread 一个文件夹（`agents/<threadId>/session.jsonl`），
 * 身份、父子与状态记在 Blackboard 的 `agent` 记录里，激活复用 `AgentRegistry`。
 *
 * 取舍：
 *
 * - **身份不写进 Session 之外的地方**。可恢复配置（label、goal、depth、permission）在
 *   Blackboard；Agent 自己的模型历史仍只在该 Session 的 JSONL 里。两者通过 `threadId`
 *   关联，不互相复制。
 * - **`ensureRoot` 只保证身份**。协调者 Thread 的记录与目录在第一次打开 Project 时建立；
 *   真正开始跑要等 `activate`。这样「创建 Project」不会顺手拉起一个 Agent。
 * - **激活有单例保证**。同一进程里同一个 Thread 只会有一个 `LiveAgent`：并发 `activate`
 *   共享同一个 promise。
 * - **委派只收窄**。深度与并行子线程数超限以 `THREAD_LIMIT` 拒绝，权限取父子中更窄的一个。
 */
export class LocalThreadService extends ThreadService {
  private readonly projectId: string
  private readonly root: string
  private readonly sessionRoot: string
  private readonly llm: LLMAdapter
  private readonly contextWindow: number | undefined
  private readonly maxDepth: number
  private readonly maxChildren: number
  private readonly permission: ThreadPermission
  private readonly coordinatorPrompt: string
  private readonly threadPrompt: string
  private readonly setupAgent: LocalThreadConfig['setupAgent']
  private readonly registry: AgentRegistry
  private readonly board: BlackboardService
  private readonly handles = new Map<string, AgentHandle>()
  private readonly activating = new Map<string, Promise<LiveAgent>>()

  constructor(ctx: Context, config: LocalThreadConfig) {
    super(ctx)
    if (!config?.projectId || !ID_PATTERN.test(config.projectId)) {
      throw new ThreadError(`invalid project id: ${String(config?.projectId)}`, 'THREAD_INVALID')
    }
    if (!config.root || typeof config.root !== 'string') {
      throw new ThreadError('thread-local requires a root directory', 'THREAD_INVALID')
    }
    const registry = ctx.get('agents') as AgentRegistry | undefined
    if (!registry) {
      throw new ThreadError('thread-local requires the live Agent registry', 'THREAD_FAILED')
    }
    const board = ctx.get('blackboard') as BlackboardService | undefined
    if (!board) {
      throw new ThreadError(
        'thread-local requires a Blackboard provider in the same scope',
        'THREAD_FAILED',
      )
    }
    const limits = DEFAULT_THREAD_LIMITS
    this.maxDepth = config.maxDepth ?? limits.maxDepth
    this.maxChildren = config.maxChildren ?? limits.maxChildren
    if (!Number.isSafeInteger(this.maxDepth) || this.maxDepth < 0
      || !Number.isSafeInteger(this.maxChildren) || this.maxChildren < 1) {
      throw new ThreadError('thread limits must be non-negative integers', 'THREAD_INVALID')
    }
    this.projectId = config.projectId
    this.root = resolve(config.root)
    this.sessionRoot = resolve(config.sessionRoot ?? config.root)
    this.llm = config.llm
    this.contextWindow = config.contextWindow
    this.permission = config.permission ?? 'read-only'
    this.coordinatorPrompt = config.coordinatorPrompt ?? COORDINATOR_SYSTEM_PROMPT
    this.threadPrompt = config.threadPrompt ?? THREAD_SYSTEM_PROMPT
    this.setupAgent = config.setupAgent
    this.registry = registry
    this.board = board
  }

  protected override async runSpawn(request: ThreadSpawnRequest): Promise<ThreadRecord> {
    const goal = normalizeGoal(request?.goal)
    const parent = await this.requireThread(request?.parentId)
    const depth = parent.depth + 1
    if (depth > this.maxDepth) {
      throw new ThreadError(
        `thread depth limit reached (max ${this.maxDepth})`,
        'THREAD_LIMIT',
      )
    }
    const siblings = await this.list({ parentId: parent.id })
    if (siblings.filter(thread => thread.state === 'working').length >= this.maxChildren) {
      throw new ThreadError(
        `thread concurrency limit reached (max ${this.maxChildren})`,
        'THREAD_LIMIT',
      )
    }
    const id = randomUUID()
    const label = request.label?.trim() || defaultLabel(goal)
    const record: ThreadRecord = {
      id,
      projectId: this.projectId,
      parentId: parent.id,
      label,
      goal,
      state: 'idle',
      depth,
      permission: narrowPermission(request.permission, parent.permission),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(request.expect?.trim() ? { expect: request.expect.trim() } : {}),
      ...(request.onReport?.trim() ? { onReport: request.onReport.trim() } : {}),
    }
    await mkdir(join(this.root, 'agents', id), { recursive: true })
    const fact = await this.board.commit({
      kind: 'agent',
      id,
      data: toData(record),
      author: parent.id,
      source: { agentId: parent.id },
      expectedVersion: null,
    })
    try {
      await this.ensureAgent(record)
    } catch (error) {
      await this.board.commit({
        kind: 'agent',
        id,
        data: toData(record),
        author: parent.id,
        expectedVersion: fact.version,
        deleted: true,
      }).catch(() => undefined)
      throw error
    }
    return toThread(fact)
  }

  override async ensureRoot(project: {
    id: string
    name: string
    coordinatorId: string
    goal?: string
  }): Promise<ThreadRecord> {
    if (project?.id !== this.projectId) {
      throw new ThreadError(
        `thread-local is bound to project ${this.projectId}, not ${String(project?.id)}`,
        'THREAD_INVALID',
      )
    }
    const existing = await this.get(project.coordinatorId)
    if (existing) return existing
    const record: ThreadRecord = {
      id: project.coordinatorId,
      projectId: this.projectId,
      label: project.name,
      goal: project.goal?.trim() || 'Coordinate this project and talk to the user.',
      state: 'idle',
      depth: 0,
      permission: this.permission,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await mkdir(join(this.root, 'agents', record.id), { recursive: true })
    try {
      const fact = await this.board.commit({
        kind: 'agent',
        id: record.id,
        data: toData(record),
        author: 'user',
        expectedVersion: null,
      })
      return toThread(fact)
    } catch (error) {
      // 另一个打开者已经建立了同一个协调者 Thread：回到它，而不是报错。
      if (error instanceof BlackboardError && error.code === 'BLACKBOARD_CONFLICT') {
        const existing = await this.get(record.id)
        if (existing) return existing
      }
      throw error
    }
  }

  override async get(threadId: string): Promise<ThreadRecord | undefined> {
    if (!ID_PATTERN.test(threadId)) return undefined
    const fact = await this.board.read('agent', threadId)
    if (!fact || fact.deleted) return undefined
    return toThread(fact)
  }

  override async list(options: ThreadListOptions = {}): Promise<ThreadRecord[]> {
    const facts = await this.board.list('agent')
    const records = facts.map(toThread)
    if (!options.parentId) return records
    const parents = new Set([options.parentId])
    if (options.descendants) {
      let size = 0
      while (size !== parents.size) {
        size = parents.size
        for (const record of records) {
          if (record.parentId && parents.has(record.parentId)) parents.add(record.id)
        }
      }
    }
    return records.filter(record => record.parentId !== undefined && parents.has(record.parentId))
  }

  override async setState(
    threadId: string,
    state: ThreadState,
    detail?: string,
  ): Promise<ThreadRecord> {
    if (!(THREAD_STATES as readonly string[]).includes(state)) {
      throw new ThreadError(`unknown thread state: ${String(state)}`, 'THREAD_INVALID')
    }
    return await this.update(threadId, current => {
      const next: ThreadRecord = { ...current, state }
      if (detail?.trim()) next.detail = detail.trim()
      else delete next.detail
      return next
    })
  }

  override async setChecklist(
    threadId: string,
    items: readonly ThreadChecklistItem[],
  ): Promise<ThreadRecord> {
    const checklist = normalizeChecklist(items)
    return await this.update(threadId, current => {
      const next: ThreadRecord = { ...current }
      if (checklist.length) next.checklist = checklist
      else delete next.checklist
      return next
    })
  }

  /** 读当前记录、改写、按读到的版本条件提交；版本不符说明有人先改了。 */
  private async update(
    threadId: string,
    change: (current: ThreadRecord) => ThreadRecord,
  ): Promise<ThreadRecord> {
    const fact = await this.board.read('agent', threadId)
    if (!fact || fact.deleted) {
      throw new ThreadError(`thread not found: ${threadId}`, 'THREAD_NOT_FOUND')
    }
    const current = toThread(fact)
    const next: ThreadRecord = { ...change(current), updatedAt: Date.now() }
    try {
      const committed = await this.board.commit({
        kind: 'agent',
        id: threadId,
        data: toData(next),
        author: current.id,
        expectedVersion: fact.version,
      })
      return toThread(committed)
    } catch (error) {
      if (error instanceof BlackboardError && error.code === 'BLACKBOARD_CONFLICT') {
        throw new ThreadError(
          `thread ${threadId} changed while it was being updated; reload and retry`,
          'THREAD_FAILED',
          { cause: error },
        )
      }
      throw error
    }
  }

  override async activate(threadId: string): Promise<LiveAgent> {
    const running = this.registry.get(threadId)
    if (running) return running
    const pending = this.activating.get(threadId)
    if (pending) return pending
    const activation = this.activateOnce(threadId)
    this.activating.set(threadId, activation)
    try {
      return await activation
    } finally {
      this.activating.delete(threadId)
    }
  }

  override async idle(threadId: string): Promise<void> {
    await (await this.activate(threadId)).whenIdle()
  }

  override sessionFile(threadId: string): string {
    if (!ID_PATTERN.test(threadId)) {
      throw new ThreadError(`invalid thread id: ${threadId}`, 'THREAD_INVALID')
    }
    return join(this.sessionRoot, 'agents', threadId, 'session.jsonl')
  }

  async dispose(): Promise<void> {
    for (const handle of [...this.handles.values()].reverse()) {
      await handle.dispose().catch(() => undefined)
    }
    this.handles.clear()
  }

  private async activateOnce(threadId: string): Promise<LiveAgent> {
    const record = await this.requireThread(threadId)
    return await this.ensureAgent(record)
  }

  private async ensureAgent(record: ThreadRecord): Promise<LiveAgent> {
    const running = this.registry.get(record.id)
    if (running) return running
    const file = this.sessionFile(record.id)
    const parentId = record.parentId
    const options = {
      file,
      id: record.id,
      sessionId: record.id,
      llm: this.llm,
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      system: parentId === undefined ? this.coordinatorPrompt : this.threadPrompt,
      title: record.label,
      createdAt: record.createdAt,
      ...(this.setupAgent ? { setup: async (agentCtx: Context) => { await this.setupAgent?.(agentCtx, record) } } : {}),
      // 协调者 Thread 没有父：它是这个 Project 的根 Agent。
      ...(parentId === undefined ? {} : { owner: parentId, parentSessionId: parentId }),
    }
    const handle = await (await hasAgentMeta(file)
      ? this.registry.resume(options)
      : this.registry.create(options))
    this.handles.set(record.id, handle)
    return handle.agent
  }

  private async requireThread(threadId: unknown): Promise<ThreadRecord> {
    if (typeof threadId !== 'string' || !ID_PATTERN.test(threadId)) {
      throw new ThreadError(`invalid thread id: ${String(threadId)}`, 'THREAD_INVALID')
    }
    const record = await this.get(threadId)
    if (!record) throw new ThreadError(`thread not found: ${threadId}`, 'THREAD_NOT_FOUND')
    return record
  }
}

export const threadLocal = {
  name: 'thread-local',
  inject: ['agents', 'blackboard'],
  apply(ctx: Context, config: LocalThreadConfig): void {
    const service = new LocalThreadService(ctx, config)
    ctx.fiber.effect(() => () => service.dispose(), 'dispose threads')
  },
}
