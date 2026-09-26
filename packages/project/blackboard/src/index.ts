import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface Context {
    blackboard: BlackboardService
  }
}

/**
 * Project 共享事实的种类。每一种对应一个由某条缝拥有的数据形状：
 *
 * | kind | data 形状 | 拥有者 |
 * |---|---|---|
 * | `project` | `ProjectRecord` | `@tnega/project` |
 * | `agent` | `ThreadRecord` | `@tnega/thread` |
 * | `message` | `BoxEnvelope` | `@tnega/box` |
 * | `delivery` | `DeliveryRecord` | `@tnega/box` |
 * | `memory` / `decision` / `resource` / `artifact` | 见 `@tnega/tool-blackboard` | Blackboard |
 * | `dependency` | Thread 之间的依赖 | `@tnega/thread` |
 */
export type FactKind =
  | 'project'
  | 'agent'
  | 'message'
  | 'delivery'
  | 'memory'
  | 'decision'
  | 'resource'
  | 'artifact'
  | 'dependency'

export const FACT_KINDS: readonly FactKind[] = [
  'project',
  'agent',
  'message',
  'delivery',
  'memory',
  'decision',
  'resource',
  'artifact',
  'dependency',
]

export type BlackboardErrorCode =
  /** 请求本身不合法：未知 kind、非法 id、无法序列化或过大的 data。 */
  | 'BLACKBOARD_INVALID'
  /** 目标记录已存在但没有给 `expectedVersion`；拒绝隐式的最后写入覆盖。 */
  | 'BLACKBOARD_VERSION_REQUIRED'
  /** `expectedVersion` 与当前版本不符；当前记录随错误一起返回。 */
  | 'BLACKBOARD_CONFLICT'
  | 'BLACKBOARD_NOT_FOUND'
  /** 存储真的失败了：权限、磁盘、后端不可用。 */
  | 'BLACKBOARD_FAILED'

export class BlackboardError extends Error {
  override name = 'BlackboardError'

  constructor(
    message: string,
    readonly code: BlackboardErrorCode,
    options?: ErrorOptions & { current?: FactRecord },
  ) {
    super(message, options)
    if (options?.current) this.current = options.current
  }

  /** `BLACKBOARD_CONFLICT` 时携带的当前记录，供写入者重新读取后合并。 */
  readonly current?: FactRecord
}

/** 这条事实从哪来。三者都可缺省：人工编辑与系统写入没有来源消息。 */
export interface FactSource {
  /** 触发的 Box 消息。 */
  messageId?: string
  /** 触发的 Session 事件。 */
  sessionEventId?: string
  /** 写入的 Agent。用户编辑时用 `user`。 */
  agentId?: string
}

export interface FactRecord<T = unknown> {
  kind: FactKind
  id: string
  /** Provider 分配的单调游标，只增不减，用作有序读取的 `after`。 */
  seq: number
  /** 从 1 开始，每次提交 +1；删除也是新版本。 */
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
   * 条件提交。记录已存在时必填：省略即 `BLACKBOARD_VERSION_REQUIRED`，与当前版本
   * 不符即 `BLACKBOARD_CONFLICT`。`null` 表示「这条记录必须尚不存在」。
   */
  expectedVersion?: number | null
  /**
   * 删除也走提交：写入 `deleted: true` 的新版本，旧版本留在 `history` 里，
   * 恢复就是再提交一次 `deleted: false`。
   */
  deleted?: boolean
}

export interface FactListOptions {
  /** 只返回 `seq` 大于该值的记录。 */
  after?: number
  limit?: number
  /** 默认不含已删除记录。 */
  includeDeleted?: boolean
}

/** 提交成功后派发的只读通知；观察者失败不影响提交结果。 */
export interface BlackboardCommitEvent {
  records: readonly FactRecord[]
}

export const MAX_FACT_DATA_BYTES = 256 * 1024

const FACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

function isKind(value: unknown): value is FactKind {
  return typeof value === 'string' && (FACT_KINDS as readonly string[]).includes(value)
}

function serializedSize(data: unknown): number {
  let text: string
  try {
    text = JSON.stringify(data)
  } catch (error) {
    throw new BlackboardError('fact data must be JSON-serializable', 'BLACKBOARD_INVALID', { cause: error })
  }
  if (text === undefined) {
    throw new BlackboardError('fact data must be JSON-serializable', 'BLACKBOARD_INVALID')
  }
  return Buffer.byteLength(text, 'utf8')
}

function assertKind(kind: unknown): asserts kind is FactKind {
  if (!isKind(kind)) {
    throw new BlackboardError(`unknown fact kind: ${String(kind)}`, 'BLACKBOARD_INVALID')
  }
}

function assertFactId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !FACT_ID_PATTERN.test(id)) {
    throw new BlackboardError(`invalid fact id: ${String(id)}`, 'BLACKBOARD_INVALID')
  }
}

function normalizeListOptions(options: FactListOptions | undefined): FactListOptions {
  const normalized: FactListOptions = {}
  if (!options) return normalized
  if (options.after !== undefined) {
    if (!Number.isSafeInteger(options.after) || options.after < 0) {
      throw new BlackboardError('after must be a non-negative integer', 'BLACKBOARD_INVALID')
    }
    normalized.after = options.after
  }
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new BlackboardError('limit must be a positive integer', 'BLACKBOARD_INVALID')
    }
    normalized.limit = options.limit
  }
  if (options.includeDeleted !== undefined) normalized.includeDeleted = options.includeDeleted
  return normalized
}

/** 校验并冻结一个提交请求；Provider 拿到的输入已经不可能非法。 */
export function normalizeCommit<T>(input: FactCommit<T>): FactCommit<T> {
  if (!input || typeof input !== 'object') {
    throw new BlackboardError('fact commit requires an object', 'BLACKBOARD_INVALID')
  }
  assertKind(input.kind)
  assertFactId(input.id)
  if (typeof input.author !== 'string' || !input.author.trim()) {
    throw new BlackboardError('fact commit requires an author', 'BLACKBOARD_INVALID')
  }
  if (input.data === undefined) {
    throw new BlackboardError('fact data must not be undefined', 'BLACKBOARD_INVALID')
  }
  if (serializedSize(input.data) > MAX_FACT_DATA_BYTES) {
    throw new BlackboardError(
      `fact data exceeds ${MAX_FACT_DATA_BYTES} bytes`,
      'BLACKBOARD_INVALID',
    )
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== null
    && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) {
    throw new BlackboardError(
      'expectedVersion must be null or a positive integer',
      'BLACKBOARD_INVALID',
    )
  }
  const commit: FactCommit<T> = {
    kind: input.kind,
    id: input.id,
    data: input.data,
    author: input.author.trim(),
  }
  if (input.source) commit.source = input.source
  if (input.expectedVersion !== undefined) commit.expectedVersion = input.expectedVersion
  if (input.deleted !== undefined) commit.deleted = input.deleted === true
  return commit
}

async function notifyCommit(ctx: Context, records: readonly FactRecord[]): Promise<void> {
  if (!records.length) return
  const event: BlackboardCommitEvent = { records }
  try {
    await ctx.parallel('blackboard/commit', event)
  } catch {
    // 只读观察：观察者失败不改写已落盘的事实。
  }
}

/**
 * Project 共享持久化能力的 Service Definition：有类型的版本记录与条件提交。
 *
 * 契约：
 *
 * - **不是键值存储**。`kind` 是封闭集合，每种 kind 的 `data` 形状由拥有它的缝定义；
 *   本缝不提供任意键写入，也不解释 `data` 的业务含义。
 * - **不覆盖**。已存在的记录必须带 `expectedVersion`；冲突带上当前记录返回，
 *   由写入者重新读取后合并，Provider 不做自动合并（照设计稿「不能最后写入覆盖」）。
 * - **原子批量**。`commitAll` 里任何一条失败即整批不落盘 —— Box 的信封与收件人
 *   投递记录必须一起出现，否则恢复时会看到没有投递目标的信封。
 * - **删除是新版本**。`deleted: true` 的记录保留在 `history` 里，用户纠错可追溯。
 * - **不存对话**。完整模型历史属于各 Agent 的 Session；本缝只存项目共享事实。
 * - **事件面属于本包**：`commit` / `commitAll` 是基类上的模板方法，提交成功后统一
 *   派发只读的 `blackboard/commit`；Provider 只实现 `run*`，因此任何 Provider 都
 *   自动参与该事件，也不可能绕过它。
 */
export abstract class BlackboardService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'blackboard')
  }

  async read<T = unknown>(kind: FactKind, id: string): Promise<FactRecord<T> | undefined> {
    assertKind(kind)
    assertFactId(id)
    return await this.runRead(kind, id) as FactRecord<T> | undefined
  }

  async list<T = unknown>(kind: FactKind, options?: FactListOptions): Promise<FactRecord<T>[]> {
    assertKind(kind)
    return await this.runList(kind, normalizeListOptions(options)) as FactRecord<T>[]
  }

  async history<T = unknown>(kind: FactKind, id: string): Promise<FactRecord<T>[]> {
    assertKind(kind)
    assertFactId(id)
    return await this.runHistory(kind, id) as FactRecord<T>[]
  }

  async commit<T>(input: FactCommit<T>): Promise<FactRecord<T>> {
    const record = await this.runCommit(normalizeCommit(input))
    await notifyCommit(this.ctx, [record])
    return record as FactRecord<T>
  }

  async commitAll(inputs: readonly FactCommit[]): Promise<FactRecord[]> {
    if (!inputs.length) return []
    const records = await this.runCommitAll(inputs.map(entry => normalizeCommit(entry)))
    await notifyCommit(this.ctx, records)
    return records
  }

  protected abstract runRead(kind: FactKind, id: string): Promise<FactRecord | undefined>

  protected abstract runList(kind: FactKind, options: FactListOptions): Promise<FactRecord[]>

  protected abstract runHistory(kind: FactKind, id: string): Promise<FactRecord[]>

  protected abstract runCommit(input: FactCommit): Promise<FactRecord>

  protected abstract runCommitAll(inputs: readonly FactCommit[]): Promise<FactRecord[]>
}

export default BlackboardService
