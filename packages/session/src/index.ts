import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@tnega/core'

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

export type MessageRole = 'system' | 'user' | 'assistant'

export interface MessagePayload {
  role: MessageRole
  content: string
  name?: string
  parentId?: string
}

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

export interface CheckpointPayload {
  messages: ModelMessage[]
  summary?: string
  tokensBefore?: number
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
  | 'message'
  | 'tool-call'
  | 'tool-result'
  | 'plan'
  | 'checkpoint'
  | 'meta'

export interface SessionEventBase<T extends SessionEventType, P> {
  id: string
  seq: number
  ts: number
  type: T
  payload: P
}

export type SessionEvent =
  | SessionEventBase<'message', MessagePayload>
  | SessionEventBase<'tool-call', ToolCallPayload>
  | SessionEventBase<'tool-result', ToolResultPayload>
  | SessionEventBase<'plan', PlanPayload>
  | SessionEventBase<'checkpoint', CheckpointPayload>
  | SessionEventBase<'meta', Record<string, unknown>>

export interface SessionConfig {
  file: string
  projector?: SessionProjector
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
        messages.push(...clone(event.payload.messages))
        break
      case 'message': {
        const message: ModelMessage = {
          role: event.payload.role,
          content: event.payload.content,
        }
        if (event.payload.name) message.name = event.payload.name
        messages.push(message)
        break
      }
      case 'tool-call': {
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
      case 'tool-result': {
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
    case 'message':
      return Math.ceil(event.payload.content.length / 4)
    case 'tool-call': {
      const raw = JSON.stringify(event.payload.arguments ?? {}) ?? ''
      return Math.ceil(raw.length / 4)
    }
    case 'tool-result': {
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
    if (event && event.type === 'message' && event.payload.role === 'user') return cut
    cut += 1
  }
  return candidate
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
  ) {}

  init(): Promise<void> {
    return this._run(async () => {
      await this._ensureLoaded()
    })
  }

  append(type: 'message', payload: MessagePayload): Promise<SessionEvent>
  append(type: 'tool-call', payload: ToolCallPayload): Promise<SessionEvent>
  append(type: 'tool-result', payload: ToolResultPayload): Promise<SessionEvent>
  append(type: 'plan', payload: PlanPayload): Promise<SessionEvent>
  append(type: 'checkpoint', payload: CheckpointPayload): Promise<SessionEvent>
  append(type: 'meta', payload: Record<string, unknown>): Promise<SessionEvent>
  append(type: SessionEventType, payload: SessionEvent['payload']): Promise<SessionEvent> {
    return this._run(async () => {
      await this._ensureLoaded()
      const eventPayload = clone(payload)
      if (type === 'message') {
        for (let index = this._events.length - 1; index >= 0; index -= 1) {
          const previous = this._events[index]
          if (previous?.type === 'message') {
            const messagePayload = eventPayload as MessagePayload
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
      return event
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
        event => event.id === messageId && event.type === 'message',
      )
      if (targetIndex < 0) {
        throw new Error(`message not found: ${messageId}`)
      }
      const selected: SessionEvent[] = []
      let skippedMessage = false
      for (let index = 0; index <= targetIndex; index += 1) {
        const event = this._events[index]!
        if (event.type === 'message') {
          if (!lineageIds.has(event.id)) {
            skippedMessage = true
            continue
          }
          skippedMessage = false
          selected.push(clone(event))
          continue
        }
        if (event.type === 'meta') continue
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
      const keep = resolveCompactKeep(this._events, options)
      const split = this._events.length - keep
      const prefix = this._events.slice(0, split)
      const suffix = this._events.slice(split)
      const checkpoint: SessionEvent = {
        id: randomUUID(),
        seq: this._events.at(-1)?.seq ?? 0,
        ts: Date.now(),
        type: 'checkpoint',
        payload: {
          messages: options.messages
            ? clone(options.messages)
            : this._projector(prefix),
          ...(options.summary ? { summary: options.summary } : {}),
          ...(options.tokensBefore !== undefined
            ? { tokensBefore: options.tokensBefore }
            : {}),
          ...(prefix.length ? { snapshot: prefix } : {}),
        },
      }
      const next = [checkpoint, ...suffix]
      if (next.length) {
        await writeFile(this.file, `${next.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8')
      } else {
        await writeFile(this.file, '', 'utf8')
      }
      this._events = next
      return next.length
    })
  }

  close(): Promise<void> {
    return this._queue.then(() => undefined)
  }

  private _run<T>(task: () => Promise<T>): Promise<T> {
    const next = this._queue.then(task, task)
    this._queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async _ensureLoaded(): Promise<void> {
    if (this._loaded) return
    await mkdir(dirname(resolve(this.file)), { recursive: true })
    this._events = await this._read()
    this._nextSeq = (this._events.at(-1)?.seq ?? 0) + 1
    this._loaded = true
  }

  private async _read(): Promise<SessionEvent[]> {
    try {
      const text = await readFile(this.file, 'utf8')
      const events: SessionEvent[] = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (isSessionEvent(parsed)) events.push(parsed)
      }
      return events
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private _resolveLineage(messageId: string): SessionEvent[] {
    const messages = this._events.filter(
      (event): event is Extract<SessionEvent, { type: 'message' }> => event.type === 'message',
    )
    const byId = new Map<string, Extract<SessionEvent, { type: 'message' }>>(
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
      const event: Extract<SessionEvent, { type: 'message' }> = byId.get(cursorId)!
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
    const log = new SessionLog(config.file, config.projector)
    await log.init()
    ctx.provide('session', log)
    return () => log.close()
  },
}

export const name = '@tnega/session'
