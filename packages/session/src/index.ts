import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@tnega/core'

export const SESSION_FORMAT_VERSION = 3

export class SessionFormatError extends Error {
  override name = 'SessionFormatError'
}

const liveSessions = new Map<string, SessionLog>()

function sessionFileKey(file: string): string {
  return resolve(file)
}

export type ModelRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ModelToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface ModelMessage {
  role: ModelRole
  content: string
  name?: string
  tool_call_id?: string
  tool_calls?: ModelToolCall[]
  toolOk?: boolean
  toolError?: ToolResultErrorPayload
}

export interface UserMessagePayload {
  content: string
  name?: string
  parentId?: string
}

export interface AssistantMessagePayload {
  content: string
  name?: string
  parentId?: string
  interrupted?: boolean
}

export interface SystemMessagePayload {
  content: string
  name?: string
  parentId?: string
}

export type MessageEventPayload =
  | UserMessagePayload
  | AssistantMessagePayload
  | SystemMessagePayload

export type MessageEventType = 'user/message' | 'assistant/message' | 'system/message'

export interface ToolCallPayload {
  id: string
  name: string
  arguments: unknown
}

export interface ToolResultErrorPayload {
  name?: string
  message: string
  stack?: string
}

export interface ToolResultPayload {
  id: string
  toolCallId: string
  name: string
  ok: boolean
  durationMs?: number
  output?: unknown
  error?: ToolResultErrorPayload
}

export type CancelCause =
  | { type: 'user' }
  | { type: 'abort'; message?: string }
  | { type: 'timeout'; timeoutMs: number }

export interface TurnStartPayload {
  input?: unknown
  reason?: string
}

export interface TurnEndPayload {
  finishReason?: string
  output?: string
  steps?: number
  interrupted?: boolean
  cancelCause?: CancelCause
  error?: ToolResultErrorPayload
}

export interface StepStartPayload {
  index: number
}

export interface StepEndPayload {
  index: number
  finishReason?: string
  toolCalls?: number
  interrupted?: boolean
  cancelCause?: CancelCause
  error?: ToolResultErrorPayload
}

export interface LLMRetryPayload {
  retryId: string
  retry: number
  delayMs?: number
  failure?: ToolResultErrorPayload
}

export interface LLMRetryStartedPayload {
  retryId: string
  retry: number
}

export interface CheckpointPayload {
  messages: ModelMessage[]
  summary?: string
  tokensBefore?: number
  surfaceOp?: 'replace'
  /** @deprecated v0.2 keeps raw events in place; use messages instead. */
  snapshot?: SessionEvent[]
}

export type PlanItemStatus = 'pending' | 'done' | 'failed'

export interface PlanItemPayload {
  id: string
  title: string
  status: PlanItemStatus
  detail?: string
}

export interface PlanPayload {
  items: PlanItemPayload[]
  status?: 'pending' | 'running' | 'done' | 'failed'
  summary?: string
}

export type AgentType = 'general' | 'coding'

export type SessionMode = 'auto' | 'plan' | 'execute'

export type SessionEventType =
  | MessageEventType
  | 'tool/call'
  | 'tool/result'
  | 'plan'
  | 'checkpoint'
  | 'meta'
  | 'llm/retry'
  | 'llm/retry-started'
  | 'turn/start'
  | 'turn/end'
  | 'step/start'
  | 'step/end'

export interface SessionEventBase<T extends SessionEventType, P> {
  id: string
  seq: number
  ts: number
  type: T
  payload: P
}

export type SessionEvent =
  | SessionEventBase<'user/message', UserMessagePayload>
  | SessionEventBase<'assistant/message', AssistantMessagePayload>
  | SessionEventBase<'system/message', SystemMessagePayload>
  | SessionEventBase<'tool/call', ToolCallPayload>
  | SessionEventBase<'tool/result', ToolResultPayload>
  | SessionEventBase<'plan', PlanPayload>
  | SessionEventBase<'checkpoint', CheckpointPayload>
  | SessionEventBase<'meta', Record<string, unknown>>
  | SessionEventBase<'llm/retry', LLMRetryPayload>
  | SessionEventBase<'llm/retry-started', LLMRetryStartedPayload>
  | SessionEventBase<'turn/start', TurnStartPayload>
  | SessionEventBase<'turn/end', TurnEndPayload>
  | SessionEventBase<'step/start', StepStartPayload>
  | SessionEventBase<'step/end', StepEndPayload>

function isMessageEventType(type: SessionEventType): type is MessageEventType {
  return type === 'user/message'
    || type === 'assistant/message'
    || type === 'system/message'
}

function isMessageEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: MessageEventType }> {
  return isMessageEventType(event.type)
}

export interface SessionConfig {
  file: string
  projector?: SessionProjector
  broadcast?: SessionBroadcast
}

export interface CompactOptions {
  keep?: number
  keepTokens?: number
  summary?: string
  tokensBefore?: number
  messages?: ModelMessage[]
}

export type ReplayReducer<T> = (state: T, event: SessionEvent) => T | Promise<T>

export type SessionProjector = (events: readonly SessionEvent[]) => ModelMessage[]

export type SessionBroadcast = (
  type: 'event' | 'flush',
  payload: unknown,
) => void

export interface ContextUsage {
  tokens: number
  limit: number
  ratio: number
}

export const DEFAULT_CONTEXT_LIMIT = 128_000

function isSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.seq === 'number'
    && typeof record.ts === 'number'
    && typeof record.type === 'string'
    && 'payload' in record
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function projectEvents(events: readonly SessionEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const event of events) {
    switch (event.type) {
      case 'checkpoint':
        messages.splice(0, messages.length, ...clone(event.payload.messages))
        break
      case 'user/message': {
        const message: ModelMessage = { role: 'user', content: event.payload.content }
        if (event.payload.name) message.name = event.payload.name
        messages.push(message)
        break
      }
      case 'assistant/message': {
        const message: ModelMessage = { role: 'assistant', content: event.payload.content }
        if (event.payload.name) message.name = event.payload.name
        messages.push(message)
        break
      }
      case 'system/message': {
        const message: ModelMessage = { role: 'system', content: event.payload.content }
        if (event.payload.name) message.name = event.payload.name
        messages.push(message)
        break
      }
      case 'tool/call': {
        const last = messages.at(-1)
        if (!last || last.role !== 'assistant') {
          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [],
          })
        } else if (!last.tool_calls) {
          last.tool_calls = []
        }
        messages.at(-1)!.tool_calls!.push({
          id: event.payload.id,
          name: event.payload.name,
          arguments: event.payload.arguments,
        })
        break
      }
      case 'tool/result': {
        const failed = !event.payload.ok
        const content = failed
          ? `error: ${event.payload.error?.message ?? 'unknown'}`
          : stringify(event.payload.output)
        const message: ModelMessage = {
          role: 'tool',
          content,
          tool_call_id: event.payload.toolCallId,
        }
        message.name = event.payload.name
        if (failed) {
          message.toolOk = false
          if (event.payload.error) message.toolError = event.payload.error
        }
        messages.push(message)
        break
      }
      case 'plan':
        break
      case 'meta':
        break
      case 'llm/retry':
      case 'llm/retry-started':
        break
      case 'turn/start':
      case 'turn/end':
      case 'step/start':
      case 'step/end':
        break
    }
  }
  return messages
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function estimateMessageTokens(messages: readonly ModelMessage[]): number {
  let tokens = 0
  for (const message of messages) {
    tokens += Math.ceil(message.content.length / 4)
    for (const call of message.tool_calls ?? []) {
      const raw = JSON.stringify(call.arguments ?? {}) ?? ''
      tokens += Math.ceil(raw.length / 4)
    }
  }
  return tokens
}

export function estimateEventTokens(event: SessionEvent): number {
  switch (event.type) {
    case 'user/message':
    case 'assistant/message':
    case 'system/message':
      return Math.ceil(event.payload.content.length / 4)
    case 'tool/call': {
      const raw = JSON.stringify(event.payload.arguments ?? {}) ?? ''
      return Math.ceil(raw.length / 4)
    }
    case 'tool/result': {
      const raw = event.payload.ok
        ? stringify(event.payload.output)
        : event.payload.error?.message ?? 'error'
      return Math.ceil(raw.length / 4)
    }
    case 'plan':
      return 0
    case 'checkpoint':
      return estimateMessageTokens(event.payload.messages)
    case 'meta':
      return 0
    case 'llm/retry':
    case 'llm/retry-started':
      return 0
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end':
      return 0
  }
}

export function suffixStartIndexForTokens(
  events: readonly SessionEvent[],
  targetTokens: number,
): number {
  if (!events.length || targetTokens <= 0) return 0
  let tokens = 0
  let candidate = events.length
  for (let index = events.length - 1; index >= 0; index -= 1) {
    tokens += estimateEventTokens(events[index]!)
    if (tokens >= targetTokens) {
      candidate = index
      break
    }
  }
  if (candidate === events.length) return 0
  let cut = candidate
  while (cut < events.length) {
    const event = events[cut]
    if (event?.type === 'user/message') return cut
    cut += 1
  }
  return candidate
}

export function safeCompactSplit(
  events: readonly SessionEvent[],
  splitIndex: number,
): number {
  const index = Math.max(0, Math.min(splitIndex, events.length))
  const first = events[index]
  if (first?.type === 'tool/result') {
    const callId = first.payload.toolCallId
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = events[cursor]
      if (candidate?.type === 'tool/call' && candidate.payload.id === callId) {
        return cursor
      }
    }
  }

  let openCalls = 0
  for (let cursor = 0; cursor <= events.length; cursor += 1) {
    if (cursor >= index && openCalls === 0) return cursor
    const event = events[cursor]
    if (!event) continue
    if (event.type === 'tool/call') openCalls += 1
    if (event.type === 'tool/result') openCalls = Math.max(0, openCalls - 1)
  }
  return index
}

export function repairUnclosed(
  events: readonly SessionEvent[],
): SessionEvent[] {
  const openCalls: Extract<SessionEvent, { type: 'tool/call' }>[] = []
  const openSteps: Extract<SessionEvent, { type: 'step/start' }>[] = []
  const openTurns: Extract<SessionEvent, { type: 'turn/start' }>[] = []
  for (const event of events) {
    switch (event.type) {
      case 'tool/call':
        openCalls.push(event)
        break
      case 'tool/result': {
        const callIndex = openCalls.findIndex(
          call => call.payload.id === event.payload.toolCallId,
        )
        if (callIndex >= 0) openCalls.splice(callIndex, 1)
        else openCalls.pop()
        break
      }
      case 'step/start':
        openSteps.push(event)
        break
      case 'step/end':
        openSteps.pop()
        break
      case 'turn/start':
        openTurns.push(event)
        break
      case 'turn/end':
        openTurns.pop()
        break
    }
  }

  if (!openCalls.length && !openSteps.length && !openTurns.length) return []

  const synthetic: SessionEvent[] = []
  let nextSeq = (events.at(-1)?.seq ?? 0) + 1
  let nextTs = (events.at(-1)?.ts ?? Date.now()) + 1
  const push = (type: SessionEventType, payload: SessionEvent['payload']): void => {
    synthetic.push({
      id: randomUUID(),
      seq: nextSeq,
      ts: nextTs,
      type: type as SessionEvent['type'],
      payload: clone(payload),
    } as SessionEvent)
    nextSeq += 1
    nextTs += 1
  }

  for (const call of openCalls) {
    push('tool/result', {
      id: call.payload.id,
      toolCallId: call.payload.id,
      name: call.payload.name,
      ok: false,
      error: {
        name: 'SessionInterruptedError',
        message: 'session interrupted before tool result was recorded',
      },
    })
  }
  for (const step of openSteps) {
    push('step/end', {
      index: step.payload.index,
      finishReason: 'interrupted',
      interrupted: true,
    })
  }
  for (let i = 0; i < openTurns.length; i++) {
    push('turn/end', {
      finishReason: 'interrupted',
      interrupted: true,
    })
  }
  return synthetic
}

export function resolveCompactKeep(
  events: readonly SessionEvent[],
  options: CompactOptions,
): number {
  if (
    typeof options.keepTokens === 'number'
    && Number.isFinite(options.keepTokens)
    && options.keepTokens > 0
  ) {
    return events.length - suffixStartIndexForTokens(events, options.keepTokens)
  }
  const keep = typeof options.keep === 'number' && Number.isFinite(options.keep) && options.keep > 0
    ? Math.floor(options.keep)
    : 0
  return Math.min(keep, events.length)
}

export function estimateContextUsage(
  messages: readonly ModelMessage[],
  limit = DEFAULT_CONTEXT_LIMIT,
): ContextUsage {
  const tokens = estimateMessageTokens(messages)
  return {
    tokens,
    limit,
    ratio: limit > 0 ? tokens / limit : 0,
  }
}

export class SessionLog {
  private _events: SessionEvent[] = []
  private _loaded = false
  private _nextSeq = 1
  private _queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly file: string,
    private _projector: SessionProjector = projectEvents,
    private _broadcast?: SessionBroadcast,
  ) {}

  init(): Promise<void> {
    return this._run(async () => {
      const key = sessionFileKey(this.file)
      if (!liveSessions.has(key)) liveSessions.set(key, this)
      try {
        await this._ensureLoaded()
      } catch (error) {
        if (liveSessions.get(key) === this) liveSessions.delete(key)
        throw error
      }
    })
  }

  append(type: 'user/message', payload: UserMessagePayload): Promise<SessionEvent>
  append(type: 'assistant/message', payload: AssistantMessagePayload): Promise<SessionEvent>
  append(type: 'system/message', payload: SystemMessagePayload): Promise<SessionEvent>
  append(type: 'tool/call', payload: ToolCallPayload): Promise<SessionEvent>
  append(type: 'tool/result', payload: ToolResultPayload): Promise<SessionEvent>
  append(type: 'plan', payload: PlanPayload): Promise<SessionEvent>
  append(type: 'checkpoint', payload: CheckpointPayload): Promise<SessionEvent>
  append(type: 'meta', payload: Record<string, unknown>): Promise<SessionEvent>
  append(type: 'llm/retry', payload: LLMRetryPayload): Promise<SessionEvent>
  append(type: 'llm/retry-started', payload: LLMRetryStartedPayload): Promise<SessionEvent>
  append(type: 'turn/start', payload: TurnStartPayload): Promise<SessionEvent>
  append(type: 'turn/end', payload: TurnEndPayload): Promise<SessionEvent>
  append(type: 'step/start', payload: StepStartPayload): Promise<SessionEvent>
  append(type: 'step/end', payload: StepEndPayload): Promise<SessionEvent>
  append(type: SessionEventType, payload: SessionEvent['payload']): Promise<SessionEvent> {
    return this._run(async () => {
      await this._ensureLoaded()
      const eventPayload = clone(payload)
      if (isMessageEventType(type)) {
        for (let index = this._events.length - 1; index >= 0; index -= 1) {
          const previous = this._events[index]
          if (previous && isMessageEvent(previous)) {
            const messagePayload = eventPayload as MessageEventPayload
            messagePayload.parentId ??= previous.id
            break
          }
        }
      }
      const event = {
        id: randomUUID(),
        seq: this._nextSeq,
        ts: Date.now(),
        type: type as SessionEvent['type'],
        payload: eventPayload,
      } as SessionEvent
      await appendFile(this.file, `${JSON.stringify(event)}\n`, 'utf8')
      this._events.push(event)
      this._nextSeq += 1
      this._broadcast?.('event', event)
      return event
    })
  }

  flush(): Promise<number> {
    return this._run(async () => {
      await this._ensureLoaded()
      const seq = this._nextSeq - 1
      this._broadcast?.('flush', { file: this.file, seq })
      return seq
    })
  }

  async lineage(messageId: string): Promise<SessionEvent[]> {
    return this._run(async () => {
      await this._ensureLoaded()
      return this._resolveLineage(messageId)
    })
  }

  async forkAt(messageId: string): Promise<SessionEvent[]> {
    return this._run(async () => {
      await this._ensureLoaded()
      const lineage = this._resolveLineage(messageId)
      const lineageIds = new Set(lineage.map(event => event.id))
      const targetIndex = this._events.findIndex(
        event => event.id === messageId && isMessageEvent(event),
      )
      if (targetIndex < 0) {
        throw new Error(`message not found: ${messageId}`)
      }
      const selected: SessionEvent[] = []
      let skippedMessage = false
      for (let index = 0; index <= targetIndex; index += 1) {
        const event = this._events[index]!
        if (isMessageEvent(event)) {
          if (!lineageIds.has(event.id)) {
            skippedMessage = true
            continue
          }
          skippedMessage = false
          selected.push(clone(event))
          continue
        }
        if (
          event.type === 'meta'
          || event.type === 'llm/retry'
          || event.type === 'llm/retry-started'
          || event.type.startsWith('turn/')
          || event.type.startsWith('step/')
        ) {
          continue
        }
        if (event.type === 'checkpoint') {
          selected.push(clone(event))
          continue
        }
        if (!skippedMessage) {
          selected.push(clone(event))
        }
      }
      return selected
    })
  }

  read(): Promise<SessionEvent[]> {
    return this._run(async () => {
      await this._ensureLoaded()
      return this._events.map(event => clone(event))
    })
  }

  deriveMessages(): Promise<ModelMessage[]> {
    return this._run(async () => {
      await this._ensureLoaded()
      return clone(this._projector(this._events))
    })
  }

  estimateContext(limit = DEFAULT_CONTEXT_LIMIT): Promise<ContextUsage> {
    return this._run(async () => {
      await this._ensureLoaded()
      return estimateContextUsage(this._projector(this._events), limit)
    })
  }

  replay(): Promise<SessionEvent[]>
  replay<T>(reduce: ReplayReducer<T>, initial: T): Promise<T>
  replay<T>(reduce?: ReplayReducer<T>, initial?: T): Promise<SessionEvent[] | T> {
    return this.read().then((events) => {
      if (!reduce) return events
      let state = initial as T
      let pending: Promise<void> = Promise.resolve()
      for (const event of events) {
        pending = pending.then(async () => {
          state = await reduce(state, event)
        })
      }
      return pending.then(() => state)
    })
  }

  compact(options: CompactOptions = {}): Promise<number> {
    return this._run(async () => {
      await this._ensureLoaded()
      const events = this._events
      const nonMeta: SessionEvent[] = []
      const rawIndices: number[] = []
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]!
        if (event.type === 'meta') continue
        nonMeta.push(event)
        rawIndices.push(index)
      }
      const keep = resolveCompactKeep(nonMeta, options)
      let splitIndex = Math.max(0, nonMeta.length - keep)
      splitIndex = safeCompactSplit(nonMeta, splitIndex)
      const rawSplit = rawIndices[splitIndex] ?? events.length
      const suffix = events.slice(rawSplit)
      let messages: ModelMessage[]
      if (options.messages) {
        messages = this._projector([
          {
            id: randomUUID(),
            seq: 0,
            ts: 0,
            type: 'checkpoint',
            payload: { messages: clone(options.messages) },
          },
          ...suffix,
        ])
      } else {
        messages = this._projector(events)
      }
      const checkpoint: SessionEvent = {
        id: randomUUID(),
        seq: (events.at(-1)?.seq ?? 0) + 1,
        ts: Date.now(),
        type: 'checkpoint',
        payload: {
          messages,
          surfaceOp: 'replace',
          ...(options.summary ? { summary: options.summary } : {}),
          ...(options.tokensBefore !== undefined
            ? { tokensBefore: options.tokensBefore }
            : {}),
        },
      }
      await appendFile(this.file, `${JSON.stringify(checkpoint)}\n`, 'utf8')
      this._events.push(checkpoint)
      this._nextSeq += 1
      this._broadcast?.('event', checkpoint)
      return this._events.length
    })
  }

  close(): Promise<void> {
    return this._queue.then(() => {
      const key = sessionFileKey(this.file)
      if (liveSessions.get(key) === this) liveSessions.delete(key)
    })
  }

  private _run<T>(task: () => Promise<T>): Promise<T> {
    const next = this._queue.then(task, task)
    this._queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async _ensureLoaded(): Promise<void> {
    if (this._loaded) return
    await mkdir(dirname(resolve(this.file)), { recursive: true })
    const read = await this._read()
    if (!read.existing) {
      const meta: SessionEvent = {
        id: randomUUID(),
        seq: 1,
        ts: Date.now(),
        type: 'meta',
        payload: { formatVersion: SESSION_FORMAT_VERSION },
      }
      await writeFile(this.file, `${JSON.stringify(meta)}\n`, 'utf8')
      this._events = [meta]
      this._nextSeq = 2
      this._loaded = true
      return
    }
    this._events = read.events
    this._nextSeq = (this._events.at(-1)?.seq ?? 0) + 1
    this._loaded = true
  }

  private async _read(): Promise<{ existing: boolean; events: SessionEvent[] }> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { existing: false, events: [] }
      }
      throw error
    }
    if (!text.trim()) return { existing: false, events: [] }

    const lines = text.split('\n')
    const events: SessionEvent[] = []
    let torn = false
    for (const line of lines) {
      if (!line.trim()) continue
      if (torn) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        torn = true
        continue
      }
      if (!isSessionEvent(parsed)) {
        torn = true
        continue
      }
      events.push(parsed)
    }

    this._assertFormat(events)

    const key = sessionFileKey(this.file)
    const owner = liveSessions.get(key)
    if (owner && owner !== this) {
      // A live writer owns this log; never synthesize closures over its active turn.
      return { existing: true, events }
    }

    const synthetic = repairUnclosed(events)
    if (!torn && !synthetic.length) return { existing: true, events }

    const repaired = [...events, ...synthetic]
    await writeFile(
      this.file,
      `${repaired.map(event => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    )
    return { existing: true, events: repaired }
  }

  private _assertFormat(events: readonly SessionEvent[]): void {
    let version: number | undefined
    for (const event of events) {
      if (event.type !== 'meta') continue
      const value = (event.payload as Record<string, unknown>).formatVersion
      if (typeof value === 'number') version = value
    }
    if (version === undefined) {
      throw new SessionFormatError(
        `session log is missing formatVersion; expected ${SESSION_FORMAT_VERSION}`,
      )
    }
    if (version !== SESSION_FORMAT_VERSION) {
      throw new SessionFormatError(
        `unsupported session format version ${version}; expected ${SESSION_FORMAT_VERSION}`,
      )
    }
  }

  private _resolveLineage(messageId: string): SessionEvent[] {
    const messages = this._events.filter(
      (event): event is Extract<SessionEvent, { type: MessageEventType }> => isMessageEvent(event),
    )
    const byId = new Map<string, Extract<SessionEvent, { type: MessageEventType }>>(
      messages.map(event => [event.id, event] as const),
    )
    if (!byId.has(messageId)) {
      throw new Error(`message not found: ${messageId}`)
    }
    const chain: SessionEvent[] = []
    const seen = new Set<string>()
    let cursorId: string | undefined = messageId
    while (cursorId && byId.has(cursorId) && !seen.has(cursorId)) {
      seen.add(cursorId)
      const event: Extract<SessionEvent, { type: MessageEventType }> = byId.get(cursorId)!
      chain.unshift(clone(event))
      const parentId: string | undefined = event.payload.parentId
      if (parentId && byId.has(parentId)) {
        cursorId = parentId
        continue
      }
      const index = messages.findIndex(message => message.id === cursorId)
      cursorId = index > 0 ? messages[index - 1]!.id : undefined
    }
    return chain
  }
}

export const session = {
  name: 'session',
  apply: async (ctx: Context, config: SessionConfig) => {
    const log = new SessionLog(config.file, config.projector, config.broadcast ?? ((type, payload) => {
      if (type === 'event') ctx.emit('session/event', payload)
      else ctx.emit('session/flush', payload)
    }))
    await log.init()
    ctx.provide('session', log)
    return () => log.close()
  },
}

export const name = '@tnega/session'
