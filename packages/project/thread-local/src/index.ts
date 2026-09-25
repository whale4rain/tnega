import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AgentHandle, AgentRegistry, LiveAgent, LLMAdapter } from '@tnega/agent'
import { BlackboardError, type BlackboardService, type FactRecord } from '@tnega/blackboard'
import type { Context } from '@tnega/core'
import {
  DEFAULT_THREAD_LIMITS,
  ThreadError,
  ThreadService,
  defaultLabel,
  narrowPermission,
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
]

export const COORDINATOR_SYSTEM_PROMPT = `You are the coordinator Agent of a Tnega project. The main conversation belongs to you: the user sends work here and reads your reports here.

Answer a small question directly in the main conversation. When a piece of work deserves its own context, delegate it with spawn_thread and say in the same reply which thread you started or reused. Threads run on their own; their reports arrive in your inbox as messages from agent:<threadId>. Never block waiting for a thread — keep the conversation responsive and report again when results arrive.

Keep project-level facts (shared memory, decisions, artifacts) on the Blackboard so later threads can find them instead of asking the user again. Outward actions such as sending mail or publishing need the user's explicit authorization first.`

export const THREAD_SYSTEM_PROMPT = `You are a Tnega project thread Agent working on one goal inside a project. Your parent and you communicate through durable inbox messages: use send_thread_message to report progress, ask for a decision, or return the result. Your parent does not see your tool calls or your intermediate conversation.

Read the shared project facts you need from the Blackboard before asking for context. You may delegate a self-contained piece of work to a child thread when it deserves its own context. Finish with a concise result and any remaining risk.`

export interface LocalThreadConfig {
  projectId: string
  /** Project 目录，约定 `<workspace>/.tnega/projects/<projectId>`。 */
  root: string
  llm: LLMAdapter
  contextWindow?: number
  maxDepth?: number
  maxChildren?: number
  /** Project 授权：所有子 Thread 的上限。 */
  permission?: ThreadPermission
  coordinatorPrompt?: string
  threadPrompt?: string
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
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
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
  private readonly llm: LLMAdapter
  private readonly contextWindow: number | undefined
  private readonly maxDepth: number
  private readonly maxChildren: number
  private readonly permission: ThreadPermission
  private readonly coordinatorPrompt: string
  private readonly threadPrompt: string
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
    this.llm = config.llm
    this.contextWindow = config.contextWindow
    this.permission = config.permission ?? 'read-only'
    this.coordinatorPrompt = config.coordinatorPrompt ?? COORDINATOR_SYSTEM_PROMPT
    this.threadPrompt = config.threadPrompt ?? THREAD_SYSTEM_PROMPT
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
    const fact = await this.board.read('agent', threadId)
    if (!fact || fact.deleted) {
      throw new ThreadError(`thread not found: ${threadId}`, 'THREAD_NOT_FOUND')
    }
    const current = toThread(fact)
    const next: ThreadRecord = {
      ...current,
      state,
      updatedAt: Date.now(),
    }
    if (detail?.trim()) next.detail = detail.trim()
    else delete next.detail
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
    return join(this.root, 'agents', threadId, 'session.jsonl')
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
      // 协调者 Thread 没有父：它是这个 Project 的根 Agent。
      ...(parentId === undefined ? {} : { owner: parentId, parentSessionId: parentId }),
    }
    const handle = await (await exists(file)
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
