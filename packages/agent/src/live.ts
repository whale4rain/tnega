import { randomUUID } from 'node:crypto'
import type { Context, Plugin } from '@tnega/core'
import { SessionLog, type SessionProjector } from '@tnega/session'
import { AgentInbox, AgentService } from './service.js'
import { DurableInbox, type DurableInboxMessage } from './inbox-durable.js'
import type {
  AgentCancelCause,
  AgentContextBudget,
  AgentHooks,
  AgentInput,
  LLMAdapter,
} from './types.js'

export interface LiveInboxView {
  readonly size: number
  snapshot(): { nextTurn: readonly DurableInboxMessage[]; nextStep: readonly DurableInboxMessage[] }
}

export type AgentStatus = 'idle' | 'running'

export interface AgentCancelOptions {
  keepInbox?: boolean
}

export interface LiveAgent {
  readonly id: string
  readonly status: AgentStatus
  readonly inbox: LiveInboxView
  readonly session: SessionLog
  readonly ctx: Context
  followup(input: AgentInput): void
  steer(input: AgentInput): void
  inject(key: string, value: unknown): void
  send(input: AgentInput, options?: { mode?: 'followup' | 'steer' }): void
  cancel(cause: AgentCancelCause, options?: AgentCancelOptions): void
  whenIdle(): Promise<void>
  dispose(): Promise<void>
}

export interface AgentHandle {
  agent: LiveAgent
  dispose(): Promise<void>
}

export interface AgentCreationOptions {
  id?: string
  file: string
  llm?: LLMAdapter
  system?: string
  projector?: SessionProjector
  maxTurns?: number
  maxSteps?: number
  contextBudget?: AgentContextBudget
  hooks?: AgentHooks
  initial?: readonly AgentInput[]
  owner?: string
}

export interface AgentFactory {
  create(options: AgentCreationOptions): Promise<AgentHandle>
  resume(options: AgentCreationOptions): Promise<AgentHandle>
}

class LiveAgentImpl implements LiveAgent {
  private _status: AgentStatus = 'idle'
  private _disposed = false
  private _controller: AbortController | undefined
  private _drainPromise: Promise<void> | undefined
  private _busy = false
  private _writeTail: Promise<void> = Promise.resolve()
  private _pendingWrite: Promise<void> | undefined
  private _durable: DurableInbox
  private _agentSystem: string | undefined

  constructor(
    private _ctx: Context,
    private _service: AgentService,
    readonly id: string,
    readonly inbox: LiveInboxView,
    readonly session: SessionLog,
    durable: DurableInbox,
  ) {
    this._durable = durable
  }

  get status(): AgentStatus {
    return this._status
  }

  get ctx(): Context {
    return this._ctx
  }

  followup(input: AgentInput): void {
    this._send(input, 'followup')
  }

  steer(input: AgentInput): void {
    this._send(input, 'steer')
  }

  inject(key: string, value: unknown): void {
    if (key === 'agentSystem' && typeof value === 'string') {
      this._agentSystem = value
    }
  }

  send(input: AgentInput, options: { mode?: 'followup' | 'steer' } = {}): void {
    this._send(input, options.mode === 'steer' ? 'steer' : 'followup')
  }

  private _send(input: AgentInput, target: 'followup' | 'steer'): void {
    if (this._disposed) throw new Error(`agent disposed: ${this.id}`)
    const text = input.text ?? ''
    const content = input.messages ?? input.context
    const task = this._writeTail.then(async () => {
      const message = target === 'steer'
        ? await this._durable.steer({ text, ...(content !== undefined ? { content } : {}) })
        : await this._durable.insert({ text, ...(content !== undefined ? { content } : {}) })
      this._ctx.emit('agent/inbox/inserted', {
        id: this.id,
        target,
        input: message,
        inboxSeq: this._durable.size,
      })
    }).catch((error: unknown) => {
      this._ctx.emit('agent/error', { id: this.id, error })
    })
    this._writeTail = task
    this._pendingWrite = task
    task.finally(() => {
      if (this._pendingWrite === task) this._pendingWrite = undefined
      queueMicrotask(() => this._wake())
    })
  }

  cancel(cause: AgentCancelCause, options: AgentCancelOptions = {}): void {
    if (!options.keepInbox) {
      const task = this._writeTail.then(async () => {
        const before = this._durable.snapshot()
        for (const message of [...before.nextStep, ...before.nextTurn]) {
          this._ctx.emit('agent/inbox/discarded', { id: this.id, message })
        }
        await this._durable.clear()
      }).catch((error: unknown) => {
        this._ctx.emit('agent/error', { id: this.id, error })
      })
      this._writeTail = task
      this._pendingWrite = task
      task.finally(() => {
        if (this._pendingWrite === task) this._pendingWrite = undefined
      })
    }
    this._controller?.abort(cause)
  }

  async whenIdle(): Promise<void> {
    while (this._pendingWrite) await this._pendingWrite
    while (true) {
      const drain = this._drainPromise
      if (drain) {
        await drain.catch(() => undefined)
        continue
      }
      if (!this._durable.size) break
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }

  async dispose(): Promise<void> {
    if (this._disposed) return
    this._disposed = true
    this.cancel({ type: 'user' })
    await this._writeTail.catch(() => undefined)
    await this._drainPromise?.catch(() => undefined)
    this._setStatus('idle')
  }

  /** Start draining currently pending durable work without a new input. */
  wakeNow(): void {
    this._wake()
  }

  private _wake(): void {
    if (this._disposed || this._drainPromise || this._busy) return
    const task = this._drainAll()
    this._drainPromise = task
    task.finally(() => {
      if (this._drainPromise === task) this._drainPromise = undefined
    })
  }

  private async _drainAll(): Promise<void> {
    await this._writeTail.catch(() => undefined)
    if (this._durable.size) await this._drain()
  }

  private async _drain(): Promise<void> {
    this._busy = true
    this._setStatus('running')
    try {
      while (!this._disposed) {
        const durableMessage = await this._durable.claim()
        if (!durableMessage) break
        const input: AgentInput = {
          ...(durableMessage.text !== undefined ? { text: durableMessage.text } : {}),
        }
        this._ctx.emit('agent/inbox/claimed', { id: this.id, message: durableMessage, input })
        const controller = new AbortController()
        this._controller = controller
        try {
          await this._service.run(input, { signal: controller.signal })
        } catch (error) {
          if (!controller.signal.aborted) {
            this._ctx.emit('agent/error', { id: this.id, error })
          }
        } finally {
          if (this._controller === controller) this._controller = undefined
        }
      }
    } finally {
      this._busy = false
      this._setStatus('idle')
    }
  }

  private _setStatus(status: AgentStatus): void {
    const previous = this._status
    if (previous === status) return
    this._status = status
    this._ctx.emit('agent/status', { id: this.id, status, previous })
  }
}

export class AgentRegistry {
  private _agents = new Map<string, LiveAgent>()
  private _owners = new Map<string, string | undefined>()
  private _factory: AgentFactory | undefined

  constructor(private _ctx: Context) {}

  setFactory(factory: AgentFactory): () => void {
    this._factory = factory
    return () => {
      if (this._factory === factory) this._factory = undefined
    }
  }

  async create(options: AgentCreationOptions): Promise<AgentHandle> {
    if (!this._factory) throw new Error('no agent factory registered')
    const id = options.id ?? randomUUID()
    if (this._agents.has(id)) throw new Error(`agent already registered: ${id}`)
    const handle = await this._factory.create({ ...options, id })
    this._agents.set(id, handle.agent)
    this._owners.set(id, options.owner)
    this._ctx.emit('agent/created', { id, agent: handle.agent })
    return {
      agent: handle.agent,
      dispose: () => this._dispose(id, handle),
    }
  }

  async resume(options: AgentCreationOptions): Promise<AgentHandle> {
    if (!this._factory) throw new Error('no agent factory registered')
    const id = options.id ?? randomUUID()
    if (this._agents.has(id)) throw new Error(`agent already registered: ${id}`)
    const handle = await this._factory.resume({ ...options, id })
    this._agents.set(id, handle.agent)
    this._owners.set(id, options.owner)
    this._ctx.emit('agent/created', { id, agent: handle.agent })
    return {
      agent: handle.agent,
      dispose: () => this._dispose(id, handle),
    }
  }

  get(id: string): LiveAgent | undefined {
    return this._agents.get(id)
  }

  list(): LiveAgent[] {
    return [...this._agents.values()]
  }

  roots(): LiveAgent[] {
    return this.list().filter(agent => this._owners.get(agent.id) === undefined)
  }

  isOwnedBy(id: string, owner: string): boolean {
    return this._owners.get(id) === owner
  }

  private async _dispose(id: string, handle: AgentHandle): Promise<void> {
    const agent = this._agents.get(id)
    if (!agent) return
    await handle.dispose()
    this._agents.delete(id)
    this._owners.delete(id)
    this._ctx.emit('agent/disposed', { id })
  }
}

async function buildHandle(
  ctx: Context,
  options: AgentCreationOptions,
  resume = false,
): Promise<AgentHandle> {
  const log = new SessionLog(
    options.file,
    options.projector,
    (type, payload) => {
      if (type === 'event') ctx.emit('session/event', payload)
      else ctx.emit('session/flush', payload)
    },
  )
  await log.init()
  const durable = resume
    ? await DurableInbox.restore(log)
    : new DurableInbox(log)
  const injected = new AgentInbox()
  const inboxView: LiveInboxView = {
    get size() {
      return durable.size
    },
    snapshot: () => durable.snapshot(),
  }
  const service = new AgentService(ctx, {
    session: log,
    inbox: injected,
    ...(options.llm ? { llm: options.llm } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.contextBudget ? { contextBudget: options.contextBudget } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  })
  if (options.system) injected.inject('agentSystem', options.system)
  const agent = new LiveAgentImpl(ctx, service, options.id ?? randomUUID(), inboxView, log, durable)
  if (options.system) agent.inject('agentSystem', options.system)
  for (const input of options.initial ?? []) {
    await durable.insert({ text: input.text ?? '' })
  }
  if (resume && durable.size) {
    setTimeout(() => agent.wakeNow(), 0)
  }
  return { agent, dispose: () => agent.dispose() }
}

export const agents = {
  name: 'agents',
  inject: ['tools'],
  apply: (ctx: Context) => {
    const registry = new AgentRegistry(ctx)
    ctx.provide('agents', registry)
    registry.setFactory({
      create: (options) => buildHandle(ctx, options),
      resume: (options) => buildHandle(ctx, options, true),
    })
    return () => {
      for (const agent of registry.list()) {
        void agent.dispose()
      }
    }
  },
} satisfies Plugin
