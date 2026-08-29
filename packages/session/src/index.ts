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
}

export type MessageRole = 'system' | 'user' | 'assistant'

export interface MessagePayload {
  role: MessageRole
  content: string
  name?: string
}

export interface ToolCallPayload {
  id: string
  name: string
  arguments: unknown
}

export interface ToolResultPayload {
  id: string
  toolCallId: string
  name: string
  ok: boolean
  output?: unknown
  error?: {
    message: string
    stack?: string
  }
}

export interface CheckpointPayload {
  messages: ModelMessage[]
  summary?: string
  tokensBefore?: number
  snapshot?: SessionEvent[]
}

export type SessionEventType =
  | 'message'
  | 'tool-call'
  | 'tool-result'
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
  | SessionEventBase<'checkpoint', CheckpointPayload>
  | SessionEventBase<'meta', Record<string, unknown>>

export interface SessionConfig {
  file: string
}

export interface CompactOptions {
  keep?: number
  summary?: string
  tokensBefore?: number
}

export type ReplayReducer<T> = (state: T, event: SessionEvent) => T | Promise<T>

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
        const content = event.payload.ok
          ? stringify(event.payload.output)
          : `error: ${event.payload.error?.message ?? 'unknown'}`
        const message: ModelMessage = {
          role: 'tool',
          content,
          tool_call_id: event.payload.toolCallId,
        }
        message.name = event.payload.name
        messages.push(message)
        break
      }
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

export class SessionLog {
  private _events: SessionEvent[] = []
  private _loaded = false
  private _nextSeq = 1
  private _queue: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string) {}

  init(): Promise<void> {
    return this._run(async () => {
      await this._ensureLoaded()
    })
  }

  append(type: 'message', payload: MessagePayload): Promise<SessionEvent>
  append(type: 'tool-call', payload: ToolCallPayload): Promise<SessionEvent>
  append(type: 'tool-result', payload: ToolResultPayload): Promise<SessionEvent>
  append(type: 'checkpoint', payload: CheckpointPayload): Promise<SessionEvent>
  append(type: 'meta', payload: Record<string, unknown>): Promise<SessionEvent>
  append(type: SessionEventType, payload: SessionEvent['payload']): Promise<SessionEvent> {
    return this._run(async () => {
      await this._ensureLoaded()
      const event = {
        id: randomUUID(),
        seq: this._nextSeq,
        ts: Date.now(),
        type: type as SessionEvent['type'],
        payload,
      } as SessionEvent
      await appendFile(this.file, `${JSON.stringify(event)}\n`, 'utf8')
      this._events.push(event)
      this._nextSeq += 1
      return event
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
      return clone(projectEvents(this._events))
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

  async fork(targetFile?: string): Promise<SessionLog> {
    const file = targetFile ?? `${this.file}.${Date.now()}.${randomUUID()}.fork.jsonl`
    return this._run(async () => {
      await this._ensureLoaded()
      const child = new SessionLog(file)
      await child._run(async () => {
        await child._ensureLoaded()
        const events = this._events.map(event => clone(event))
        if (events.length) {
          await writeFile(child.file, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8')
        }
        child._events = events
        child._nextSeq = this._nextSeq
      })
      return child
    })
  }

  compact(options: CompactOptions = {}): Promise<number> {
    return this._run(async () => {
      await this._ensureLoaded()
      const keep = Math.max(0, Math.min(options.keep ?? 0, this._events.length))
      const split = this._events.length - keep
      const prefix = this._events.slice(0, split)
      const suffix = this._events.slice(split)
      const checkpoint: SessionEvent = {
        id: randomUUID(),
        seq: this._events.at(-1)?.seq ?? 0,
        ts: Date.now(),
        type: 'checkpoint',
        payload: {
          messages: projectEvents(prefix),
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
}

export const session = {
  name: 'session',
  apply: async (ctx: Context, config: SessionConfig) => {
    const log = new SessionLog(config.file)
    await log.init()
    ctx.provide('session', log)
    return () => log.close()
  },
}

export const name = '@tnega/session'
