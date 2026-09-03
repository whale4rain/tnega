import { randomUUID } from 'node:crypto'
import type { SessionLog, SessionEvent } from '@tnega/session'

export type DurableTarget = 'next-turn' | 'next-step'

export interface DurableInboxMessage {
  id: string
  text?: string
  content?: unknown
}

function contentOf(input: { text?: string; content?: unknown }): string {
  return input.text ?? ''
}

export class DurableInbox {
  private _nextTurn: DurableInboxMessage[] = []
  private _nextStep: DurableInboxMessage[] = []

  constructor(private _session: SessionLog) {}

  get size(): number {
    return this._nextTurn.length + this._nextStep.length
  }

  async insert(input: { text?: string; content?: unknown }, target: DurableTarget = 'next-turn'): Promise<DurableInboxMessage> {
    const message: DurableInboxMessage = {
      id: randomUUID(),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
    }
    const list = target === 'next-step' ? this._nextStep : this._nextTurn
    list.push(message)
    await this._session.append('agent/inbox/spliced', {
      target,
      index: list.length - 1,
      inserted: [{ id: message.id, content: contentOf(message) }],
    })
    return message
  }

  async steer(input: { text?: string; content?: unknown }): Promise<DurableInboxMessage> {
    const message: DurableInboxMessage = {
      id: randomUUID(),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
    }
    this._nextStep.unshift(message)
    await this._session.append('agent/inbox/spliced', {
      target: 'next-step',
      index: 0,
      inserted: [{ id: message.id, content: contentOf(message), mode: 'steer' }],
    })
    return message
  }

  async claim(): Promise<DurableInboxMessage | undefined> {
    const steered = this._nextStep.shift()
    if (steered) {
      await this._session.append('agent/inbox/spliced', {
        target: 'next-step',
        index: 0,
        deleteCount: 1,
      })
      return steered
    }
    const next = this._nextTurn.shift()
    if (next) {
      await this._session.append('agent/inbox/spliced', {
        target: 'next-turn',
        index: 0,
        deleteCount: 1,
      })
      return next
    }
    return undefined
  }

  async clear(): Promise<void> {
    if (this._nextTurn.length) {
      this._nextTurn = []
      await this._session.append('agent/inbox/spliced', {
        target: 'next-turn',
        index: 0,
        deleteCount: Number.POSITIVE_INFINITY,
      })
    }
    if (this._nextStep.length) {
      this._nextStep = []
      await this._session.append('agent/inbox/spliced', {
        target: 'next-step',
        index: 0,
        deleteCount: Number.POSITIVE_INFINITY,
      })
    }
  }

  snapshot(): { nextTurn: readonly DurableInboxMessage[]; nextStep: readonly DurableInboxMessage[] } {
    return {
      nextTurn: [...this._nextTurn],
      nextStep: [...this._nextStep],
    }
  }

  static async restore(session: SessionLog): Promise<DurableInbox> {
    const inbox = new DurableInbox(session)
    inbox._applyAll(await session.read())
    return inbox
  }

  private _applyAll(events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (event.type !== 'agent/inbox/spliced') continue
      const payload = event.payload
      const list = payload.target === 'next-step' ? this._nextStep : this._nextTurn
      const count = payload.deleteCount ?? 0
      if (count === Number.POSITIVE_INFINITY) {
        list.length = 0
      } else if (count > 0 && payload.index === 0) {
        list.splice(0, Math.min(count, list.length))
      }
      for (const item of payload.inserted ?? []) {
        const message: DurableInboxMessage = {
          id: item.id,
          ...(item.content !== undefined ? { text: item.content } : {}),
        }
        if (item.mode === 'steer') list.unshift(message)
        else list.push(message)
      }
    }
  }
}
