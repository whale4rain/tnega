import type { ArtifactRef } from '@tnega/artifact-store'
import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface Context {
    box: BoxService
  }
}

export type BoxErrorCode = 'BOX_INVALID' | 'BOX_NOT_FOUND' | 'BOX_FAILED'

export class BoxError extends Error {
  override name = 'BoxError'

  constructor(
    message: string,
    readonly code: BoxErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * Box 的收件地址。用户也是一个地址 —— 主对话就是「用户已发送的消息与其 inbox 的投影」，
 * 没有第二条消息捷径。
 */
export type BoxAddress = { kind: 'user'; id: 'user' } | { kind: 'agent'; id: string }

export type BoxMessageKind =
  /** 用户在主对话发言。 */
  | 'user-message'
  /** 用户直接给某个 Thread 留言。 */
  | 'user-thread'
  /** Agent 面向用户的回复，含从 Session 自动发布的 assistant 消息。 */
  | 'agent-reply'
  /** 父 Agent 派工。 */
  | 'dispatch'
  /** 子 Agent 的关键进展。 */
  | 'progress'
  /** 子 Agent 需要父 Agent 决定。 */
  | 'request'
  | 'complete'
  | 'blocked'
  | 'failed'
  /** 活动通知：例如用户给 Thread 留言时给协调者一条可追溯的通知。 */
  | 'notice'

export const BOX_MESSAGE_KINDS: readonly BoxMessageKind[] = [
  'user-message',
  'user-thread',
  'agent-reply',
  'dispatch',
  'progress',
  'request',
  'complete',
  'blocked',
  'failed',
  'notice',
]

/** 消息显示在哪条时间线上。 */
export type BoxPlacement = { kind: 'main' } | { kind: 'thread'; threadId: string }

export interface BoxEnvelope {
  messageId: string
  projectId: string
  /** 可信发送者。由宿主或 Agent 作用域绑定，模型不能在工具参数里伪造。 */
  sender: BoxAddress
  recipients: BoxAddress[]
  placement: BoxPlacement
  kind: BoxMessageKind
  text: string
  /** 随消息带上的产物引用，不复制内容。 */
  refs: ArtifactRef[]
  /** 派工卡片指向的 Thread。 */
  threadId?: string
  /** 把「用户要求 → 创建 Thread → 子 Agent 回报 → 协调 Agent 简报」串起来。 */
  causationId?: string
  createdAt: number
}

export interface BoxSendInput {
  sender: BoxAddress
  recipients: BoxAddress[]
  placement: BoxPlacement
  kind: BoxMessageKind
  text: string
  refs?: ArtifactRef[]
  threadId?: string
  causationId?: string
  /** 由调用方给定以取得幂等：同一 ID 重复发送不产生第二条信封。 */
  messageId?: string
  createdAt?: number
}

export interface DeliveryRecord {
  messageId: string
  recipient: BoxAddress
  /** `pending` 已入队；`delivered` 已进入收件 Session；`acked` 收件方已确认。 */
  status: 'pending' | 'delivered' | 'acked'
  attempts: number
  updatedAt: number
}

export const USER_ADDRESS: BoxAddress = { kind: 'user', id: 'user' }

export function agentAddress(id: string): BoxAddress {
  return { kind: 'agent', id }
}

export interface BoxTimelineOptions {
  after?: number
  limit?: number
}

/** 提交成功后派发的只读通知；观察者失败不影响投递事实。 */
export interface BoxSentEvent {
  envelope: BoxEnvelope
}

export function addressKey(address: BoxAddress): string {
  return address.kind === 'user' ? 'user' : `agent:${address.id}`
}

export function deliveryId(messageId: string, recipient: BoxAddress): string {
  return `${messageId}:${addressKey(recipient)}`
}

export function sameAddress(a: BoxAddress, b: BoxAddress): boolean {
  return a.kind === b.kind && a.id === b.id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeAddress(value: unknown): BoxAddress {
  if (!isRecord(value)) throw new BoxError('box address must be an object', 'BOX_INVALID')
  if (value.kind === 'user') return USER_ADDRESS
  if (value.kind === 'agent' && typeof value.id === 'string' && value.id.trim()) {
    return agentAddress(value.id.trim())
  }
  throw new BoxError(`invalid box address: ${JSON.stringify(value)}`, 'BOX_INVALID')
}

function normalizePlacement(value: unknown): BoxPlacement {
  if (!isRecord(value)) throw new BoxError('box placement must be an object', 'BOX_INVALID')
  if (value.kind === 'main') return { kind: 'main' }
  if (value.kind === 'thread' && typeof value.threadId === 'string' && value.threadId.trim()) {
    return { kind: 'thread', threadId: value.threadId.trim() }
  }
  throw new BoxError(`invalid box placement: ${JSON.stringify(value)}`, 'BOX_INVALID')
}

function normalizeRefs(value: unknown): ArtifactRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new BoxError('box refs must be an array', 'BOX_INVALID')
  return value.map(entry => {
    if (!isRecord(entry) || typeof entry.hash !== 'string'
      || typeof entry.size !== 'number' || typeof entry.mediaType !== 'string') {
      throw new BoxError(`invalid artifact ref: ${JSON.stringify(entry)}`, 'BOX_INVALID')
    }
    return { hash: entry.hash, size: entry.size, mediaType: entry.mediaType }
  })
}

/** `send` 的输入经校验后交给 Provider 的形状。 */
export interface NormalizedBoxSend {
  sender: BoxAddress
  recipients: BoxAddress[]
  placement: BoxPlacement
  kind: BoxMessageKind
  text: string
  refs: ArtifactRef[]
  /** 缺省时由 Provider 生成。 */
  messageId?: string
  threadId?: string
  causationId?: string
  createdAt: number
}

export function normalizeSend(input: BoxSendInput): NormalizedBoxSend {
  if (!isRecord(input)) throw new BoxError('box send requires an object', 'BOX_INVALID')
  const sender = normalizeAddress(input.sender)
  if (!Array.isArray(input.recipients) || !input.recipients.length) {
    throw new BoxError('box send requires at least one recipient', 'BOX_INVALID')
  }
  const recipients: BoxAddress[] = []
  for (const entry of input.recipients) {
    const address = normalizeAddress(entry)
    if (!recipients.some(existing => sameAddress(existing, address))) recipients.push(address)
  }
  if (typeof input.kind !== 'string' || !(BOX_MESSAGE_KINDS as readonly string[]).includes(input.kind)) {
    throw new BoxError(`unknown box message kind: ${String(input.kind)}`, 'BOX_INVALID')
  }
  const text = typeof input.text === 'string' ? input.text : ''
  const refs = normalizeRefs(input.refs)
  if (!text.trim() && !refs.length) {
    throw new BoxError('box message needs text or at least one ref', 'BOX_INVALID')
  }
  if (input.messageId !== undefined && (typeof input.messageId !== 'string' || !input.messageId.trim())) {
    throw new BoxError('messageId must be a non-empty string', 'BOX_INVALID')
  }
  if (input.threadId !== undefined && typeof input.threadId !== 'string') {
    throw new BoxError('threadId must be a string', 'BOX_INVALID')
  }
  if (input.causationId !== undefined && typeof input.causationId !== 'string') {
    throw new BoxError('causationId must be a string', 'BOX_INVALID')
  }
  return {
    sender,
    recipients,
    placement: normalizePlacement(input.placement),
    kind: input.kind as BoxMessageKind,
    text,
    refs,
    ...(input.messageId !== undefined ? { messageId: input.messageId.trim() } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    createdAt: input.createdAt ?? Date.now(),
  }
}

/**
 * Project 内消息通道的 Service Definition：拥有 `ctx.box`。
 *
 * 用户输入、协调 Agent 对用户的回复、父子 Agent 通信和用户对 Thread 的留言都走这里。
 * 接口保持窄：`send`、`inbox`、`ack`，加上给 UI 的 `timeline` 与查询用的 `delivery`。
 *
 * 契约：
 *
 * - **至少一次投递**。`send` 只负责把信封与每个收件人的待投递记录一次写入 Blackboard
 *   （原子批量）；投递由 Project Loop 完成，收件 Session 以 `messageId` 去重、准入并
 *   冲刷之后才 `ack`。重启后未确认的消息会被重投，已进入模型的不会再次进入。
 * - **不用回复当发送成功**。发送在信封落盘时就成功；`inbox` 只报告「还没确认的消息」，
 *   不代表收件方已经处理。
 * - **发送者不可伪造**。信封里的 `sender` 由宿主或 Agent 作用域绑定；模型可见的工具
 *   不暴露这个字段。
 * - **幂等**。`messageId` 可由调用方给定（自动发布的 assistant 消息用 Session 事件
 *   派生的稳定 ID）；同 ID 重复 `send` 返回已有信封，不产生第二条，也不重置投递状态。
 * - **不存对话**。信封是传输事实；收件 Agent 实际看见的内容仍以它自己的 Session 为准。
 *
 * 本包只承载契约与词汇，自己不注册任何服务；Provider 子类化 {@link BoxService}
 * 后以插件形式挂载。
 */
export abstract class BoxService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'box')
  }

  async send(input: BoxSendInput): Promise<BoxEnvelope> {
    const envelope = await this.runSend(normalizeSend(input))
    await this.notify(envelope)
    return envelope
  }

  /** 收件人尚未确认的消息，按信封提交顺序升序。 */
  abstract inbox(recipient: BoxAddress): Promise<BoxEnvelope[]>

  /** 按提交顺序读消息流；UI 与 Project Loop 用 `after` 游标追赶。 */
  abstract timeline(options?: BoxTimelineOptions): Promise<BoxEnvelope[]>

  /** 消息已进入收件 Session；重复标记不增加版本。 */
  abstract markDelivered(messageId: string, recipient: BoxAddress): Promise<void>

  /** 收件方确认：此后不再重投。重复确认是空操作。 */
  abstract ack(messageId: string, recipient: BoxAddress): Promise<void>

  abstract delivery(messageId: string, recipient: BoxAddress): Promise<DeliveryRecord | undefined>

  protected abstract runSend(input: NormalizedBoxSend): Promise<BoxEnvelope>

  /** 只读通知；观察者失败被吞掉，投递事实不受影响。 */
  private async notify(envelope: BoxEnvelope): Promise<void> {
    const event: BoxSentEvent = { envelope }
    try {
      await this.ctx.parallel('box/sent', event)
    } catch {
      // 只读观察：观察者失败不改写已落盘的信封。
    }
  }
}

export default BoxService
