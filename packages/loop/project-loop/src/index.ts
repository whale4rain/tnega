import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { AgentRegistry, LiveAgent } from '@tnega/agent'
import { USER_ADDRESS, type BoxEnvelope, type BoxService } from '@tnega/box'
import type { Context, Plugin } from '@tnega/core'
import { SessionLog, type SessionEvent } from '@tnega/session'
import type { ThreadRecord, ThreadService } from '@tnega/thread'

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export interface ProjectLoopConfig {
  projectId: string
  /** 挂载时重投未确认的消息并补发未发布的回复；默认 true。 */
  recover?: boolean
  /**
   * 兜底重扫间隔（毫秒）。`box/sent` 与 `agent/status` 会立即触发一次投递，这个间隔
   * 只覆盖「没有任何事件到达」的情况；设为 0 关闭定时兜底。
   */
  sweepIntervalMs?: number
}

export const DEFAULT_SWEEP_INTERVAL_MS = 15_000

const TERMINAL_KINDS: Partial<Record<BoxEnvelope['kind'], ThreadRecord['state']>> = {
  complete: 'done',
  blocked: 'blocked',
  failed: 'failed',
  request: 'waiting',
  progress: 'working',
}

/**
 * 自动发布的回复的稳定 ID。
 *
 * 由 `projectId` / `agentId` / Session 事件 ID 派生，因此同一段模型输出无论发布几次都得到
 * 同一个 `messageId`：崩溃后重新发布会被 Box 的幂等路径吸收，而不是产生第二条消息。
 */
export function publishedMessageId(
  projectId: string,
  agentId: string,
  sessionEventId: string,
): string {
  return createHash('sha256')
    .update(`${projectId} ${agentId} ${sessionEventId}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * 投递给 Agent 的消息在 Session 里的署名。
 *
 * Durable inbox 的 `content` 只接受模型消息数组 —— 它是这条输入进入模型时的形状。
 * 因此信封身份不放进消息体，而是放进这条 user 消息的 `name`：Session 的
 * `user/message` 事件因此记下了「这条输入来自哪个 Box 信封」，`messageId` 就是去重键。
 * 发送者不再另存一份：它由 Box 里的同一个 `messageId` 决定，不复制就不会漂移。
 */
export function boxMessageName(messageId: string): string {
  return `box:${messageId}`
}

function boxIdOfName(name: unknown): string | undefined {
  return typeof name === 'string' && name.startsWith('box:') ? name.slice(4) : undefined
}

/** 这条 Box 消息是否已经作为输入进入过该 Session。 */
function admitted(events: readonly SessionEvent[], messageId: string): boolean {
  return events.some(event => event.type === 'user/message'
    && event.payload.name === boxMessageName(messageId))
}

/** 该 Session 里最后一次收到的 Box 消息，用作后续回复的因果引用。 */
function lastInboundMessageId(events: readonly SessionEvent[]): string | undefined {
  let found: string | undefined
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const id = boxIdOfName(event.payload.name)
    if (id) found = id
  }
  return found
}

/**
 * 从 Session 事件里挑出「面向用户的回复」。
 *
 * 带工具调用的 assistant 消息是执行过程中的中间叙述，属于 Thread 的执行记录，不作为
 * 对话消息发布；只有不带工具调用、且有正文的那条才是这一轮的回复。
 */
function isReply(event: SessionEvent): event is SessionEvent & {
  payload: { content: string; toolCalls?: unknown[] }
} {
  if (event.type !== 'assistant/message') return false
  const payload = event.payload
  return typeof payload.content === 'string'
    && payload.content.trim().length > 0
    && !(Array.isArray(payload.toolCalls) && payload.toolCalls.length > 0)
}

/**
 * Project Loop：Project 级的协作循环，装在 Project 作用域里。
 *
 * 它只做四件事，都不涉及模型与对话内容：
 *
 * 1. **投递**。把未确认的 Box 信封送进收件 Agent 的 durable inbox，收件 Session 准入并
 *    冲刷之后才确认；`messageId` 已经在 Session 里出现过就只补确认，不重复进入模型。
 * 2. **唤醒**。空闲的收件 Agent 用 `followup` 起一轮；运行中的用 `steer`，在新消息到达
 *    的下个安全 step 边界进入，绝不打断正在进行的工具调用。
 * 3. **发布**。Agent 的 Session 落入面向用户的回复后自动发布到 Box，让主对话与 Thread
 *    面板各自看到自己那条时间线。
 * 4. **回报**。`complete` / `blocked` / `failed` / `request` 这类信封到达时更新发送方
 *    Thread 的状态；子 Thread 自己没回报时，用这轮的结论补一条给父 Agent。
 *
 * 它不替代单个 Agent 的模型请求与工具执行 —— 每个 Thread 仍由自己的 Agent Loop 驱动，
 * 每个 Agent 恰有自己的 Session。
 */
export class ProjectLoopRuntime {
  private readonly projectId: string
  private readonly box: BoxService
  private readonly threads: ThreadService
  private readonly registry: AgentRegistry
  private readonly attached = new Set<string>()
  /** 子 Thread 最近一次发给父 Agent 的回报正文，用来避免重复补发。 */
  private readonly reported = new Map<string, string>()
  private known = new Map<string, ThreadRecord>()
  private dirty = false
  private running: Promise<void> | undefined
  private statusTail: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private sweeper: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(private readonly ctx: Context, config: ProjectLoopConfig) {
    if (!config?.projectId || typeof config.projectId !== 'string') {
      throw new Error('project-loop requires a projectId')
    }
    const box = ctx.get('box') as BoxService | undefined
    const threads = ctx.get('threads') as ThreadService | undefined
    const registry = ctx.get('agents') as AgentRegistry | undefined
    if (!box || !threads || !registry) {
      throw new Error('project-loop requires box, threads and the live Agent registry')
    }
    this.projectId = config.projectId
    this.box = box
    this.threads = threads
    this.registry = registry
  }

  /** 挂上事件面并做第一次扫描。 */
  start(options: { recover?: boolean; sweepIntervalMs?: number } = {}): void {
    this.ctx.on('box/sent', (event: { envelope: BoxEnvelope }) => {
      // 回报的正文在这里就记下来：`send` 发生在子 Agent 的 turn 里，比 turn 结束早。
      if (TERMINAL_KINDS[event.envelope.kind] && event.envelope.sender.kind === 'agent') {
        this.reported.set(event.envelope.sender.id, event.envelope.text.trim())
      }
      this.schedule()
    })
    this.ctx.on('thread/spawned', (event: { thread: ThreadRecord }) => {
      this.known.set(event.thread.id, event.thread)
      this.schedule()
    })
    this.ctx.on('agent/created', (event: { id: string; agent: LiveAgent }) => {
      this.attach(event.id, event.agent)
    })
    this.ctx.on('agent/status', (event: { id: string; status: 'idle' | 'running' }) => {
      this.queueStatus(event.id, event.status)
    })
    for (const agent of this.registry.list()) this.attach(agent.id, agent)

    const interval = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    if (interval > 0) {
      this.sweeper = setInterval(() => this.schedule(), interval)
      this.sweeper.unref?.()
    }
    if (options.recover !== false) void this.recover()
    this.schedule()
  }

  /** 重投未确认的消息，并补发所有没来得及发布的回复。 */
  async recover(): Promise<void> {
    await this.refresh()
    for (const thread of this.known.values()) {
      await this.publishThread(thread.id).catch(error => this.fail(error))
    }
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.sweeper) clearInterval(this.sweeper)
    this.timer = undefined
    this.sweeper = undefined
  }

  /** 把某个 Agent 的 Session 事件接到发布路径上；随该 Agent 的作用域一起卸载。 */
  private attach(agentId: string, agent: LiveAgent): void {
    if (this.attached.has(agentId)) return
    this.attached.add(agentId)
    agent.ctx.on('session/event', (event: SessionEvent) => {
      void this.onSessionEvent(agentId, event).catch(error => this.fail(error))
    })
  }

  private async onSessionEvent(agentId: string, event: SessionEvent): Promise<void> {
    if (!this.known.has(agentId) || !isReply(event)) return
    const history = await this.readSession(agentId)
    await this.publish(agentId, history, [event])
  }

  /** 一次投递扫描；同一时刻只有一条扫描链在跑，期间的新事件排到链尾。 */
  private schedule(): void {
    if (this.disposed) return
    this.dirty = true
    if (this.timer || this.running) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, 0)
    this.timer.unref?.()
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.running) return
    const task = this.scan()
    this.running = task
    try {
      await task
    } catch (error) {
      this.fail(error)
    } finally {
      this.running = undefined
      if (this.dirty && !this.disposed) this.schedule()
    }
  }

  private async scan(): Promise<void> {
    while (this.dirty && !this.disposed) {
      this.dirty = false
      await this.refresh()
      for (const id of [...this.known.keys()]) {
        if (this.disposed) return
        await this.deliver(id).catch(error => this.fail(error))
      }
    }
  }

  private async refresh(): Promise<void> {
    const records = await this.threads.list()
    this.known = new Map(records.map(record => [record.id, record]))
    for (const agent of this.registry.list()) {
      if (this.known.has(agent.id)) this.attach(agent.id, agent)
    }
  }

  /** 把还欠这个 Thread 的信封送进它的 inbox，准入并冲刷之后才确认。 */
  private async deliver(threadId: string): Promise<void> {
    const recipient = { kind: 'agent' as const, id: threadId }
    const pending = await this.box.inbox(recipient)
    if (!pending.length) return
    const agent = await this.threads.activate(threadId)
    for (const envelope of pending) {
      if (this.disposed) return
      const events = await agent.session.read()
      const isNew = !admitted(events, envelope.messageId)
      // 先把信封读出来的状态落定，再唤醒收件方。反过来的话，收件方可能在唤醒之后
      // 立刻跑完并回到 idle，随后到达的「开始工作」会把 idle 覆盖掉。
      await this.applyEnvelopeState(threadId, envelope)
      if (isNew) {
        const input = {
          messages: [{
            role: 'user' as const,
            name: boxMessageName(envelope.messageId),
            content: envelope.text,
          }],
        }
        if (agent.status === 'running') await agent.steer(input)
        else await agent.followup(input)
        await agent.session.flush()
      }
      await this.box.markDelivered(envelope.messageId, recipient)
      await this.box.ack(envelope.messageId, recipient)
    }
  }

  /**
   * 信封决定 Thread 状态：派工说的是收件方开始工作，回报说的是发送方自己的结论。
   * 状态由 Project Loop 从消息类型读出，不要求模型额外上报。
   */
  private async applyEnvelopeState(threadId: string, envelope: BoxEnvelope): Promise<void> {
    if (envelope.kind === 'dispatch') {
      await this.setStateSafely(threadId, 'working')
      return
    }
    const state = TERMINAL_KINDS[envelope.kind]
    if (!state || envelope.sender.kind !== 'agent') return
    await this.setStateSafely(envelope.sender.id, state, envelope.text)
  }

  private async setStateSafely(
    threadId: string,
    state: ThreadRecord['state'],
    detail?: string,
  ): Promise<void> {
    if (!this.known.has(threadId)) return
    try {
      const record = await this.threads.setState(threadId, state, detail)
      this.known.set(threadId, record)
    } catch (error) {
      this.fail(error)
    }
  }

  /**
   * 状态转移按到达顺序处理。`running` 与 `idle` 是一对异步事件，交错处理会让
   * 「跑完了」先于「开始跑了」落库，于是 idle 被当成过期结论丢掉。
   */
  private queueStatus(agentId: string, status: 'idle' | 'running'): void {
    const task = this.statusTail.then(() => this.onStatus(agentId, status))
    this.statusTail = task.then(() => undefined, error => this.fail(error))
  }

  private async onStatus(agentId: string, status: 'idle' | 'running'): Promise<void> {
    if (!this.known.has(agentId)) return
    // 读当前事实而不是缓存：缓存在这条链之外还可能被投递路径改写。
    const record = await this.threads.get(agentId)
    if (!record) return
    if (status === 'running') {
      await this.setStateSafely(agentId, 'working')
      return
    }
    // 空闲只把「正在跑」收回成「空闲」；`waiting` / `blocked` 这类结论由信封决定，
    // 不因为一轮跑完就被抹掉。
    if (record.state !== 'working') return
    await this.setStateSafely(agentId, 'idle')
    await this.reportTurnEnd(agentId)
  }

  /**
   * 一轮跑完之后父 Agent 要能自动继续：子 Thread 自己没回报过时，Project Loop 用这轮的
   * 结论补一条 `complete` 给直接父 Agent。已经作为回报发出去的正文不重复补。
   *
   * 补发消息的 ID 由「这一轮的回复事件」派生，因此同一轮重复触发只会命中同一个信封。
   */
  private async reportTurnEnd(agentId: string): Promise<void> {
    const record = this.known.get(agentId)
    if (!record?.parentId) return
    const events = await this.readSession(agentId)
    const reply = [...events].reverse().find(isReply)
    if (!reply) return
    const text = reply.payload.content.trim()
    if (this.reported.get(agentId) === text) return
    const recipient = { kind: 'agent' as const, id: record.parentId }
    const messageId = publishedMessageId(this.projectId, agentId, `report ${reply.id}`)
    if (await this.box.delivery(messageId, recipient)) return
    const causationId = lastInboundMessageId(events)
    await this.box.send({
      sender: { kind: 'agent', id: agentId },
      recipients: [recipient],
      placement: { kind: 'thread', threadId: agentId },
      kind: 'complete',
      text,
      messageId,
      ...(causationId ? { causationId } : {}),
      createdAt: reply.ts,
    })
  }

  private async publishThread(threadId: string): Promise<void> {
    if (!this.known.has(threadId)) return
    const events = await this.readSession(threadId)
    const start = await this.firstUnpublished(threadId, events)
    if (start >= events.length) return
    await this.publish(threadId, events, events.slice(start))
  }

  /** 把 `slice` 里尚未发布过的回复发到 Box；`history` 用来定位因果引用。 */
  private async publish(
    agentId: string,
    history: readonly SessionEvent[],
    slice: readonly SessionEvent[],
  ): Promise<void> {
    const record = this.known.get(agentId)
    if (!record) return
    const placement: BoxEnvelope['placement'] = record.parentId === undefined
      ? { kind: 'main' }
      : { kind: 'thread', threadId: agentId }
    const causationId = lastInboundMessageId(history)
    for (const event of slice) {
      if (!isReply(event)) continue
      const messageId = publishedMessageId(this.projectId, agentId, event.id)
      if (await this.box.delivery(messageId, USER_ADDRESS)) continue
      await this.box.send({
        sender: { kind: 'agent', id: agentId },
        recipients: [USER_ADDRESS],
        placement,
        kind: 'agent-reply',
        text: event.payload.content,
        messageId,
        ...(causationId ? { causationId } : {}),
        createdAt: event.ts,
      })
    }
  }

  /**
   * 从尾部往回找第一条还没发布的回复：回复是按顺序发布的，所以它之后的部分就是欠发的
   * 那一段。这比重扫整份 Session 便宜，也让恢复的开销随「欠发的量」增长。
   */
  private async firstUnpublished(
    threadId: string,
    events: readonly SessionEvent[],
  ): Promise<number> {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (!isReply(event)) continue
      const messageId = publishedMessageId(this.projectId, threadId, event.id)
      if (await this.box.delivery(messageId, USER_ADDRESS)) return index + 1
    }
    return 0
  }

  /**
   * 读某个 Thread 的 Session。
   *
   * 先确认文件存在再打开：`SessionLog` 第一次读不存在的文件时会把它建出来，于是「读过
   * 一次」会在磁盘上留下一个没有 Agent 身份的假 Session。
   */
  private async readSession(threadId: string): Promise<readonly SessionEvent[]> {
    const live = this.registry.get(threadId)
    if (live) return await live.session.read()
    const file = this.threads.sessionFile(threadId)
    if (!await fileExists(file)) return []
    let log: SessionLog | undefined
    try {
      log = new SessionLog(file)
      await log.init()
      return await log.read()
    } catch {
      return []
    } finally {
      await log?.close().catch(() => undefined)
    }
  }

  private fail(error: unknown): void {
    try {
      this.ctx.emit('project-loop/error', { projectId: this.projectId, error })
    } catch {
      // 观察者失败不能反过来打断循环。
    }
  }
}

export const projectLoop: Plugin = {
  name: 'project-loop',
  inject: ['box', 'threads', 'agents'],
  apply(ctx: Context, config: ProjectLoopConfig): void {
    const runtime = new ProjectLoopRuntime(ctx, config)
    ctx.fiber.effect(() => () => runtime.dispose(), 'dispose project loop')
    runtime.start({
      ...(config.recover !== undefined ? { recover: config.recover } : {}),
      ...(config.sweepIntervalMs !== undefined ? { sweepIntervalMs: config.sweepIntervalMs } : {}),
    })
  },
}
