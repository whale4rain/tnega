import { randomUUID } from 'node:crypto'
import {
  BlackboardError,
  type BlackboardService,
  type FactCommit,
  type FactRecord,
} from '@tnega/blackboard'
import {
  BoxError,
  BoxService,
  addressKey,
  deliveryId,
  normalizeAddress,
  sameAddress,
  type BoxAddress,
  type BoxEnvelope,
  type BoxTimelineOptions,
  type DeliveryRecord,
  type NormalizedBoxSend,
} from '@tnega/box'
import type { Context } from '@tnega/core'

export interface BoxBlackboardConfig {
  /** 信封与投递记录所属的 Project。 */
  projectId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toEnvelope(fact: FactRecord): BoxEnvelope {
  const data = fact.data
  if (!isRecord(data) || typeof data.projectId !== 'string' || typeof data.kind !== 'string'
    || typeof data.text !== 'string' || !isRecord(data.placement)) {
    throw new BoxError(`box message ${fact.id} is malformed`, 'BOX_FAILED')
  }
  const envelope: BoxEnvelope = {
    messageId: fact.id,
    projectId: data.projectId,
    sender: normalizeAddress(data.sender),
    recipients: Array.isArray(data.recipients) ? data.recipients.map(normalizeAddress) : [],
    placement: data.placement.kind === 'thread'
      ? { kind: 'thread', threadId: String(data.placement.threadId ?? '') }
      : { kind: 'main' },
    kind: data.kind as BoxEnvelope['kind'],
    text: data.text,
    refs: Array.isArray(data.refs)
      ? data.refs.filter(isRecord).map(ref => ({
        hash: String(ref.hash ?? ''),
        size: Number(ref.size ?? 0),
        mediaType: String(ref.mediaType ?? ''),
      }))
      : [],
    createdAt: Number(data.createdAt ?? fact.createdAt),
  }
  if (typeof data.threadId === 'string') envelope.threadId = data.threadId
  if (typeof data.causationId === 'string') envelope.causationId = data.causationId
  return envelope
}

function toDelivery(fact: FactRecord): DeliveryRecord {
  const data = fact.data
  if (!isRecord(data) || !isRecord(data.recipient) || typeof data.status !== 'string') {
    throw new BoxError(`delivery record ${fact.id} is malformed`, 'BOX_FAILED')
  }
  return {
    messageId: typeof data.messageId === 'string' ? data.messageId : fact.id.split(':')[0] ?? '',
    recipient: normalizeAddress(data.recipient),
    status: data.status as DeliveryRecord['status'],
    attempts: Number(data.attempts ?? 0),
    updatedAt: fact.updatedAt,
  }
}

/**
 * 基于 Blackboard 的 Box Provider：信封与每个收件人的待投递记录一次写入。
 *
 * 取舍：
 *
 * - **信封与投递记录同一批提交**。`commitAll` 保证要么都出现，要么都不出现；否则崩溃
 *   恢复会看到没有投递目标的信封，或者有目标却没有内容的空投递。
 * - **`pending` 与 `delivered` 都是「未确认」**。`inbox` 返回两者，Project Loop 负责
 *   重投 —— 至少一次投递的实现放在 Loop 里，Provider 只报告事实。
 * - **同 ID 重复 `send` 返回已有信封**。自动发布的 assistant 消息用 Session 事件派生的
 *   稳定 ID，崩溃后重新发布不该产生第二条消息，也不该把已经 ack 的投递重置成待投递。
 * - **`ack` 幂等**。重复确认不产生新版本，避免 journal 被无意义的状态行填满。
 */
export class BoxBlackboardService extends BoxService {
  private readonly projectId: string
  private readonly board: BlackboardService

  constructor(ctx: Context, config: BoxBlackboardConfig) {
    super(ctx)
    if (!config?.projectId || typeof config.projectId !== 'string') {
      throw new BoxError('box-blackboard requires a projectId', 'BOX_INVALID')
    }
    const board = ctx.get('blackboard') as BlackboardService | undefined
    if (!board) {
      throw new BoxError(
        'box-blackboard requires a Blackboard provider in the same scope',
        'BOX_FAILED',
      )
    }
    this.projectId = config.projectId
    this.board = board
  }

  protected override async runSend(input: NormalizedBoxSend): Promise<BoxEnvelope> {
    const messageId = input.messageId ?? randomUUID()
    const existing = await this.board.read('message', messageId)
    if (existing && !existing.deleted) return toEnvelope(existing)

    const envelope: BoxEnvelope = {
      messageId,
      projectId: this.projectId,
      sender: input.sender,
      recipients: input.recipients,
      placement: input.placement,
      kind: input.kind,
      text: input.text,
      refs: input.refs,
      createdAt: input.createdAt,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    }
    const now = Date.now()
    const commits: FactCommit[] = [{
      kind: 'message',
      id: messageId,
      data: envelope,
      author: addressKey(input.sender),
      ...(input.sender.kind === 'agent' ? { source: { agentId: input.sender.id } } : {}),
      expectedVersion: null,
    }]
    for (const recipient of input.recipients) {
      commits.push({
        kind: 'delivery',
        id: deliveryId(messageId, recipient),
        data: {
          messageId,
          recipient,
          status: 'pending',
          attempts: 0,
          updatedAt: now,
        } satisfies DeliveryRecord,
        author: 'box',
        expectedVersion: null,
      })
    }
    try {
      await this.board.commitAll(commits)
    } catch (error) {
      // 并发发布同一条消息：另一个写入者的信封已经落盘，返回它即可。
      if (error instanceof BlackboardError && error.code === 'BLACKBOARD_CONFLICT') {
        const raced = await this.board.read('message', messageId)
        if (raced) return toEnvelope(raced)
      }
      throw error
    }
    return envelope
  }

  override async inbox(recipient: BoxAddress): Promise<BoxEnvelope[]> {
    const wanted = normalizeAddress(recipient)
    const deliveries = await this.board.list('delivery')
    const pending = deliveries
      .map(toDelivery)
      .filter(record => sameAddress(record.recipient, wanted) && record.status !== 'acked')
    const envelopes: Array<{ seq: number; envelope: BoxEnvelope }> = []
    for (const record of pending) {
      const fact = await this.board.read('message', record.messageId)
      if (!fact || fact.deleted) {
        throw new BoxError(`delivery ${record.messageId} has no message`, 'BOX_FAILED')
      }
      envelopes.push({ seq: fact.seq, envelope: toEnvelope(fact) })
    }
    return envelopes.sort((a, b) => a.seq - b.seq).map(entry => entry.envelope)
  }

  override async timeline(options: BoxTimelineOptions = {}): Promise<BoxEnvelope[]> {
    const facts = await this.board.list('message', {
      ...(options.after !== undefined ? { after: options.after } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    })
    return facts.map(toEnvelope)
  }

  override async markDelivered(messageId: string, recipient: BoxAddress): Promise<void> {
    await this.advance(messageId, recipient, 'delivered')
  }

  override async ack(messageId: string, recipient: BoxAddress): Promise<void> {
    await this.advance(messageId, recipient, 'acked')
  }

  override async delivery(
    messageId: string,
    recipient: BoxAddress,
  ): Promise<DeliveryRecord | undefined> {
    const fact = await this.board.read('delivery', deliveryId(messageId, normalizeAddress(recipient)))
    if (!fact || fact.deleted) return undefined
    return toDelivery(fact)
  }

  /**
   * 推进投递状态。每次 `delivered` 都是一次实际投递尝试，因此 `attempts` 递增；
   * `acked` 之后不再变更 —— 重投与重复确认都是空操作。
   */
  private async advance(
    messageId: string,
    recipient: BoxAddress,
    status: DeliveryRecord['status'],
  ): Promise<void> {
    const address = normalizeAddress(recipient)
    const id = deliveryId(messageId, address)
    const fact = await this.board.read('delivery', id)
    if (!fact || fact.deleted) {
      throw new BoxError(`delivery not found: ${id}`, 'BOX_NOT_FOUND')
    }
    const current = toDelivery(fact)
    if (current.status === 'acked') return
    try {
      await this.board.commit({
        kind: 'delivery',
        id,
        data: {
          messageId: current.messageId,
          recipient: address,
          status,
          attempts: status === 'delivered' ? current.attempts + 1 : current.attempts,
          updatedAt: Date.now(),
        } satisfies DeliveryRecord,
        author: 'box',
        expectedVersion: fact.version,
      })
    } catch (error) {
      // 另一个写入者已经推进了同一条记录：同一状态转换写成哪个版本都一样。
      if (error instanceof BlackboardError && error.code === 'BLACKBOARD_CONFLICT') return
      throw error
    }
  }
}

export const boxBlackboard = {
  name: 'box-blackboard',
  inject: ['blackboard'],
  apply(ctx: Context, config: BoxBlackboardConfig): void {
    new BoxBlackboardService(ctx, config)
  },
}
