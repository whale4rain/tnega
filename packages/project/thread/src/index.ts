import type { LiveAgent } from '@tnega/agent'
import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface Context {
    threads: ThreadService
  }
}

export type ThreadErrorCode =
  | 'THREAD_INVALID'
  | 'THREAD_NOT_FOUND'
  /** 父子深度或并行子线程数超限。 */
  | 'THREAD_LIMIT'
  | 'THREAD_FAILED'

export class ThreadError extends Error {
  override name = 'ThreadError'

  constructor(
    message: string,
    readonly code: ThreadErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * Thread 的稳定工作状态。这里没有「已提交待验收」—— 普通工作可以用自然语言结束；
 * 需要证据或用户明确要求验收时才启用 Eval / Review。
 */
export type ThreadState =
  /** 正在跑一个 Agent Run。 */
  | 'working'
  /** 等父 Agent 决定（`request` 已发出）。 */
  | 'waiting'
  /** 受阻，需要外部条件。 */
  | 'blocked'
  /** 空闲：还有后续工作可以继续交代。 */
  | 'idle'
  | 'done'
  | 'failed'

export type ThreadPermission = 'read-only' | 'workspace-write' | 'bypass'

/**
 * Thread 是 Project 中一个可持续交互的 Agent 身份：稳定 ID、一个文件夹、一个 Session。
 *
 * 它不是一次任务 —— 用户可以从主对话卡片再次进入同一个 Thread 补充要求，回到的是同一个
 * Agent。需要彻底重启上下文或更换不兼容配置时，创建有来源链接的新 Thread，而不是在一个
 * Thread 下面套第二个 Session。
 */
export interface ThreadRecord {
  /** 等于该 Agent 的 `agentId`，也是它文件夹的名字。 */
  id: string
  projectId: string
  /** 直接父 Thread；协调者 Thread 没有父。 */
  parentId?: string
  label: string
  /** 交代给它的目标。 */
  goal: string
  /** 期望的回报形状；缺省表示自然语言结果即可。 */
  expect?: string
  state: ThreadState
  /** 状态说明：阻塞原因、失败原因或最近一次回报的摘要。 */
  detail?: string
  depth: number
  permission: ThreadPermission
  createdAt: number
  updatedAt: number
}

export interface ThreadSpawnRequest {
  /** 发起者，必须是已存在的 Thread。 */
  parentId: string
  goal: string
  label?: string
  expect?: string
  /** 只能比父 Thread 更窄。 */
  permission?: ThreadPermission
}

export interface ThreadListOptions {
  parentId?: string
  /** 连同所有后代一起返回，而不是只返回直接子级。 */
  descendants?: boolean
}

const PERMISSIONS: readonly ThreadPermission[] = ['read-only', 'workspace-write', 'bypass']

export function isThreadPermission(value: unknown): value is ThreadPermission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}

/** 子 Thread 的权限上限是父 Thread 的权限，只能收窄不能放宽。 */
export function narrowPermission(
  requested: ThreadPermission | undefined,
  parent: ThreadPermission,
): ThreadPermission {
  const rank = (value: ThreadPermission): number => PERMISSIONS.indexOf(value)
  if (!requested) return parent
  return rank(requested) < rank(parent) ? requested : parent
}

export function normalizeGoal(goal: unknown): string {
  if (typeof goal !== 'string') throw new ThreadError('thread goal must be a string', 'THREAD_INVALID')
  const trimmed = goal.trim()
  if (!trimmed) throw new ThreadError('thread goal must not be empty', 'THREAD_INVALID')
  return trimmed
}

export function defaultLabel(goal: string): string {
  return goal.length > 64 ? `${goal.slice(0, 63)}…` : goal
}

export const DEFAULT_THREAD_MAX_DEPTH = 2
export const DEFAULT_THREAD_MAX_CHILDREN = 3

export interface ThreadLimits {
  maxDepth: number
  maxChildren: number
}

export const DEFAULT_THREAD_LIMITS: ThreadLimits = {
  maxDepth: DEFAULT_THREAD_MAX_DEPTH,
  maxChildren: DEFAULT_THREAD_MAX_CHILDREN,
}

/** `spawn` 成功后派发的只读通知。 */
export interface ThreadSpawnedEvent {
  thread: ThreadRecord
}

/**
 * Thread 生命周期的 Service Definition：拥有 `ctx.threads`。
 *
 * 契约：
 *
 * - **一个 Thread = 一个 Agent 身份**。稳定 ID、一个文件夹、一个 Session。Agent Run 是
 *   这个身份的一段执行，不是新的 Thread。恢复出来的 Thread 仍然是同一个 Thread。
 * - **父子是持久事实**。关系记在 Blackboard，不在内存里；重启后仍能重建整棵树。
 * - **父 Agent 不同步等待子 Agent**。`spawn` 立刻返回，子 Agent 的结果由 Project Loop
 *   通过 Box 送回父 Agent 的 inbox。
 * - **委派只收窄**。子 Thread 的权限上限是父 Thread 的权限；深度与并行子线程数受宿主
 *   配置限制，超限以 `THREAD_LIMIT` 拒绝。
 * - **不搬对话**。首封工作消息不携带父 Agent 的 Session 历史；需要的上下文通过
 *   Blackboard 引用传递。
 *
 * 本包只承载契约与词汇，自己不注册任何服务；Provider 子类化 {@link ThreadService}
 * 后以插件形式挂载。底层的 Agent 文件夹、Session 与激活机制复用 `@tnega/agent` 的
 * `AgentRegistry`。
 */
export abstract class ThreadService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'threads')
  }

  /** 建立子 Thread：Agent 文件夹、Session、父子关系。首封工作消息由调用方经 Box 投递。 */
  async spawn(request: ThreadSpawnRequest): Promise<ThreadRecord> {
    const thread = await this.runSpawn(request)
    await this.notifySpawned(thread)
    return thread
  }

  /** 协调者 Thread：Project 创建时建立，parentId 为空，depth 为 0。 */
  abstract ensureRoot(project: { id: string; name: string; coordinatorId: string; goal?: string }): Promise<ThreadRecord>

  abstract get(threadId: string): Promise<ThreadRecord | undefined>

  abstract list(options?: ThreadListOptions): Promise<ThreadRecord[]>

  abstract setState(threadId: string, state: ThreadState, detail?: string): Promise<ThreadRecord>

  /** 激活或恢复该 Thread 的 Agent；同一 ID 在进程内只有一个实例。 */
  abstract activate(threadId: string): Promise<LiveAgent>

  /** 等到该 Thread 当前的工作安静下来；没有在跑的工作时立即返回。 */
  abstract idle(threadId: string): Promise<void>

  /** 该 Thread 的 Session 文件路径；UI 与调试用。 */
  abstract sessionFile(threadId: string): string

  protected abstract runSpawn(request: ThreadSpawnRequest): Promise<ThreadRecord>

  private async notifySpawned(thread: ThreadRecord): Promise<void> {
    const event: ThreadSpawnedEvent = { thread }
    try {
      await this.ctx.parallel('thread/spawned', event)
    } catch {
      // 只读观察：观察者失败不改写已建立的 Thread。
    }
  }
}

export default ThreadService
