import { randomUUID } from 'node:crypto'
import type { Context, Plugin } from '@tnega/core'
import { SessionLog, type SessionEvent, type SessionProjector } from '@tnega/session'
import { AgentInbox, AgentService } from './service.js'
import { AgentError } from './service.js'
import { DurableInbox, type DurableInboxMessage } from './inbox-durable.js'
import type {
  AgentCancelCause,
  AgentContextBudget,
  AgentHooks,
  AgentInput,
  LLMAdapter,
} from './types.js'

export interface AgentSessionMeta {
  agentId: string
  agentType?: 'general' | 'coding'
  mode?: 'auto' | 'plan' | 'execute'
  title?: string
  owner?: string
  parentSessionId?: string
  forkedAtMessageId?: string
  createdAt?: number
}

/** Synchronous finalizer invoked immediately before agent publication. */
export interface AgentSetupCommit {
  commit(): void
}

/** Compose an unpublished agent scope; a throw rejects the whole creation. */
export type AgentSetup = (
  agentCtx: Context,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void

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
  readonly meta: AgentSessionMeta
  readonly agentType: 'general' | 'coding' | undefined
  readonly mode: 'auto' | 'plan' | 'execute' | undefined
  readonly owner: string | undefined
  readonly parentSessionId: string | undefined
  readonly status: AgentStatus
  readonly inbox: LiveInboxView
  readonly session: SessionLog
  readonly ctx: Context
  /** The scoped context setup composes before publication. */
  readonly agentCtx: Context
  followup(input: AgentInput): void
  steer(input: AgentInput): void
  replaceMessage(messageId: string, input: AgentInput): void
  removeMessage(messageId: string): void
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
  file: string
  /** Stable identity shared by this process and future resumes. */
  sessionId?: string
  agentType?: 'general' | 'coding'
  mode?: 'auto' | 'plan' | 'execute'
  title?: string
  owner?: string
  parentSessionId?: string
  forkedAtMessageId?: string
  id?: string
  /** Optional composition callback run before the agent is published. */
  setup?: AgentSetup
  llm?: LLMAdapter
  system?: string
  projector?: SessionProjector
  maxTurns?: number
  maxSteps?: number
  contextBudget?: AgentContextBudget
  hooks?: AgentHooks
  initial?: readonly AgentInput[]
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
  private _sessionStarted = false
  private _setupDisposers: Array<() => Promise<void> | void> = []
  private _scopeClosed = false
  private _durable: DurableInbox
  private _agentSystem: string | undefined

  constructor(
    private _ctx: Context,
    private _agentCtx: Context,
    private _service: AgentService,
    readonly id: string,
    readonly inbox: LiveInboxView,
    readonly session: SessionLog,
    durable: DurableInbox,
    readonly meta: AgentSessionMeta,
  ) {
    this._durable = durable
  }

  get agentType(): 'general' | 'coding' | undefined {
    return this.meta.agentType
  }

  get mode(): 'auto' | 'plan' | 'execute' | undefined {
    return this.meta.mode
  }

  get owner(): string | undefined {
    return this.meta.owner
  }

  get parentSessionId(): string | undefined {
    return this.meta.parentSessionId
  }

  get agentCtx(): Context {
    return this._agentCtx
  }

  trackSetupDispose(dispose: () => Promise<void> | void): void {
    if (this._scopeClosed) void dispose()
    else this._setupDisposers.push(dispose)
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

  /** Replace one pending inbox message by durable message id. */
  replaceMessage(messageId: string, input: AgentInput): void {
    this._mutatePending(async () => {
      const previous = this._durable.get(messageId)
      if (!previous) return
      const replacement = await this._durable.replace(messageId, {
        text: input.text ?? '',
        ...(input.messages !== undefined || input.context !== undefined
          ? { content: input.messages ?? input.context }
          : {}),
      })
      if (!replacement) return
      this._ctx.emit('agent/inbox/discarded', {
        id: this.id,
        agent: this,
        message: previous,
      })
      this._ctx.emit('agent/inbox/inserted', {
        id: this.id,
        agent: this,
        target: this._findTarget(messageId) ?? 'next-turn',
        input: replacement,
        inboxSeq: this._durable.size,
      })
    })
  }

  /** Remove one pending inbox message by durable message id. */
  removeMessage(messageId: string): void {
    this._mutatePending(async () => {
      const removed = await this._durable.remove(messageId)
      if (!removed) return
      this._ctx.emit('agent/inbox/discarded', {
        id: this.id,
        agent: this,
        message: removed,
      })
    })
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

  private _mutatePending(task: () => Promise<void>): void {
    if (this._disposed) throw new Error(`agent disposed: ${this.id}`)
    const chained = this._writeTail.then(task).catch((error: unknown) => {
      this._ctx.emit('agent/error', { id: this.id, error })
    })
    this._writeTail = chained
    this._pendingWrite = chained
    chained.finally(() => {
      if (this._pendingWrite === chained) this._pendingWrite = undefined
    })
  }

  private _findTarget(messageId: string): 'next-turn' | 'next-step' | undefined {
    const snapshot = this._durable.snapshot()
    if (snapshot.nextStep.some(message => message.id === messageId)) return 'next-step'
    if (snapshot.nextTurn.some(message => message.id === messageId)) return 'next-turn'
    return undefined
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
    if (!this._scopeClosed) {
      this._scopeClosed = true
      await Promise.all([...this._setupDisposers].reverse().map(dispose => dispose()))
    }
    const writeTail = this._writeTail
    if (writeTail !== this._drainPromise && this._pendingWrite) {
      this._pendingWrite = undefined
      await writeTail.catch(() => undefined)
    }
    this._setStatus('idle')
  }

  /** Publish the agent lifecycle session-start notification once. */
  async publishSessionStart(source: 'startup' | 'resume' = 'startup'): Promise<void> {
    if (this._sessionStarted) return
    this._sessionStarted = true
    this._ctx.emit('agent/session-start', {
      id: this.id,
      agent: this,
      source,
    })
  }

  /** Current durable turn number for a newly claimed inbox item. */
  private async _nextTurnNumber(): Promise<number> {
    const events = await this.session.read()
    let max = 0
    for (const event of events) {
      if (event.type === 'turn/start') max = Math.max(max, event.payload.turn)
    }
    return max + 1
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
        const turn = await this._nextTurnNumber()
        this._ctx.emit('agent/inbox/claimed', {
          id: this.id,
          agent: this,
          message: durableMessage,
          input,
          turn,
        })
        const controller = new AbortController()
        this._controller = controller
        try {
          await this._service.run(input, { signal: controller.signal })
        } catch (error) {
          if (!controller.signal.aborted) {
            const step = await this._failedStep()
            this._ctx.emit('agent/error', {
              id: this.id,
              agent: this,
              error,
              ...(step !== undefined ? { turn, step } : {}),
            })
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

  private async _failedStep(): Promise<number | undefined> {
    const events = await this.session.read()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'step/end'
        && (event.payload.finishReason === 'error'
          || event.payload.interrupted === true)) {
        return event.payload.step
      }
    }
    return undefined
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
    const id = options.id ?? options.sessionId ?? randomUUID()
    if (this._agents.has(id)) throw new Error(`agent already registered: ${id}`)
    const handle = await this._factory.create({ ...options, id })
    this._agents.set(id, handle.agent)
    this._owners.set(id, handle.agent.owner)
    this._ctx.emit('agent/created', { id, agent: handle.agent })
    return {
      agent: handle.agent,
      dispose: () => this._dispose(id, handle),
    }
  }

  async resume(options: AgentCreationOptions): Promise<AgentHandle> {
    if (!this._factory) throw new Error('no agent factory registered')
    if (!options.id && !options.sessionId) {
      throw new AgentError('agent resume requires a stable session id')
    }
    const id = options.id ?? options.sessionId!
    if (this._agents.has(id)) throw new Error(`agent already registered: ${id}`)
    const handle = await this._factory.resume({ ...options, id })
    this._agents.set(id, handle.agent)
    this._owners.set(id, handle.agent.owner)
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
  const fileMeta = await readAgentMeta(options.file)
  if (resume && !fileMeta) {
    throw new AgentError(`no agent session meta found for resume: ${options.file}`)
  }
  const requestedId = options.id ?? options.sessionId ?? randomUUID()
  if (fileMeta?.agentId && fileMeta.agentId !== requestedId) {
    throw new AgentError(
      `agent id mismatch: session belongs to ${fileMeta.agentId}, requested ${requestedId}`,
    )
  }
  const agentId = fileMeta?.agentId ?? requestedId
  if (!agentId) throw new AgentError('agent requires a stable identity')
  const log = new SessionLog(
    options.file,
    options.projector,
    (type, payload) => {
      if (type === 'event') ctx.emit('session/event', payload)
      else ctx.emit('session/flush', payload)
    },
  )
  await log.init()
  const fileEvents = await log.read()
  const durableMeta = readDurableAgentMeta(fileEvents)
  if (durableMeta) {
    if (durableMeta.agentId !== agentId) {
      throw new AgentError(
        `agent id mismatch: session belongs to ${durableMeta.agentId}, requested ${agentId}`,
      )
    }
    if (options.agentType && durableMeta.agentType !== options.agentType) {
      throw new AgentError(
        `agent type mismatch: session is ${durableMeta.agentType ?? 'untyped'}, requested ${options.agentType}`,
      )
    }
    if (options.mode && durableMeta.mode !== options.mode) {
      throw new AgentError(
        `agent mode mismatch: session is ${durableMeta.mode ?? 'unset'}, requested ${options.mode}`,
      )
    }
  }
  const boundMeta: AgentSessionMeta = {
    ...fileMeta,
    ...(durableMeta ?? {}),
    ...(options.title ? { title: options.title } : {}),
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.forkedAtMessageId ? { forkedAtMessageId: options.forkedAtMessageId } : {}),
    agentId,
  }
  const resolvedAgentType = options.agentType ?? durableMeta?.agentType
  if (resolvedAgentType) boundMeta.agentType = resolvedAgentType
  const resolvedMode = options.mode ?? durableMeta?.mode
  if (resolvedMode) boundMeta.mode = resolvedMode
  if (!durableMeta) {
    await log.append('meta', {
      kind: 'agent',
      agentId,
      ...(boundMeta.agentType ? { agentType: boundMeta.agentType } : {}),
      ...(boundMeta.mode ? { mode: boundMeta.mode } : {}),
      ...(boundMeta.title ? { title: boundMeta.title } : {}),
      ...(boundMeta.owner ? { owner: boundMeta.owner } : {}),
      ...(boundMeta.parentSessionId ? { parentSessionId: boundMeta.parentSessionId } : {}),
      ...(boundMeta.forkedAtMessageId ? { forkedAtMessageId: boundMeta.forkedAtMessageId } : {}),
      ...(boundMeta.createdAt !== undefined ? { createdAt: boundMeta.createdAt } : {}),
    })
  }
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
  const agentScope = await ctx.inject([], (scopeCtx: Context) => {
    scopeCtx.isolate('agentScope').provide('agentScope', scopeCtx)
  })
  await agentScope
  const agentCtx = agentScope.ctx
  const agent = new LiveAgentImpl(
    ctx,
    agentCtx,
    service,
    agentId,
    inboxView,
    log,
    durable,
    boundMeta,
  )
  agent.trackSetupDispose(() => agentScope.dispose())
  if (options.system) agent.inject('agentSystem', options.system)
  let setupResult: AgentSetupCommit | void
  try {
    setupResult = await options.setup?.(agentCtx)
    setupResult?.commit()
  } catch (error) {
    await agent.dispose().catch(() => undefined)
    await log.close().catch(() => undefined)
    throw error
  }
  await agent.publishSessionStart(resume ? 'resume' : 'startup')
  for (const input of options.initial ?? []) {
    if (!resume) await durable.insert({ text: input.text ?? '' })
  }
  if (resume && durable.size) {
    setTimeout(() => agent.wakeNow(), 0)
  }
  return { agent, dispose: () => agent.dispose() }
}

async function readAgentMeta(
  file: string,
): Promise<{ agentId?: string; createdAt?: number } | undefined> {
  const lines = await import('node:fs/promises').then(fs => fs.readFile(file, 'utf8'))
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
  if (lines === undefined) return undefined
  for (const line of lines.split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      record = parsed && typeof parsed === 'object'
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      continue
    }
    if (record.type !== 'meta') continue
    const payload = record.payload as Record<string, unknown> | undefined
    if (!payload || payload.kind !== 'agent') continue
    return {
      ...(typeof payload.agentId === 'string' ? { agentId: payload.agentId } : {}),
      ...(typeof payload.createdAt === 'number' ? { createdAt: payload.createdAt } : {}),
    }
  }
  return undefined
}

function readDurableAgentMeta(events: readonly SessionEvent[]): AgentSessionMeta | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'meta') continue
    const payload = event.payload as Record<string, unknown>
    if (payload.kind !== 'agent') continue
    const meta: AgentSessionMeta = {
      agentId: typeof payload.agentId === 'string' ? payload.agentId : '',
    }
    if (payload.agentType === 'general' || payload.agentType === 'coding') {
      meta.agentType = payload.agentType
    }
    if (payload.mode === 'auto' || payload.mode === 'plan' || payload.mode === 'execute') {
      meta.mode = payload.mode
    }
    if (typeof payload.title === 'string') meta.title = payload.title
    if (typeof payload.owner === 'string') meta.owner = payload.owner
    if (typeof payload.parentSessionId === 'string') {
      meta.parentSessionId = payload.parentSessionId
    }
    if (typeof payload.forkedAtMessageId === 'string') {
      meta.forkedAtMessageId = payload.forkedAtMessageId
    }
    if (typeof payload.createdAt === 'number') meta.createdAt = payload.createdAt
    return meta
  }
  return undefined
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
