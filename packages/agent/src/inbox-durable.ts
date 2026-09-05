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

  /** Insert a message at an explicit target/index boundary. */
  async insertAt(
    input: { text?: string; content?: unknown },
    target: DurableTarget,
    index: number,
    mode: 'followup' | 'steer' = 'followup',
  ): Promise<DurableInboxMessage> {
    const message: DurableInboxMessage = {
      id: randomUUID(),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
    }
    const list = target === 'next-step' ? this._nextStep : this._nextTurn
    const safeIndex = Math.max(0, Math.min(index, list.length))
    list.splice(safeIndex, 0, message)
    await this._session.append('agent/inbox/spliced', {
      target,
      index: safeIndex,
      inserted: [{ id: message.id, content: contentOf(message), mode }],
    })
    return message
  }

  /**
   * Replace one pending message by id. The old message is emitted as
   * discarded and the new one as inserted, matching the DSH inbox contract.
   */
  async replace(
    messageId: string,
    input: { text?: string; content?: unknown },
  ): Promise<DurableInboxMessage | undefined> {
    const entry = this._find(messageId)
    if (!entry) return undefined
    const replacement: DurableInboxMessage = {
      id: randomUUID(),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
    }
    const target = entry.target
    const index = entry.index
    entry.list.splice(index, 1, replacement)
    await this._session.append('agent/inbox/spliced', {
      target,
      index,
      deleteCount: 1,
      inserted: [{ id: replacement.id, content: contentOf(replacement) }],
    })
    return replacement
  }

  /** Remove one pending message by id. */
  async remove(messageId: string): Promise<DurableInboxMessage | undefined> {
    const entry = this._find(messageId)
    if (!entry) return undefined
    entry.list.splice(entry.index, 1)
    await this._session.append('agent/inbox/spliced', {
      target: entry.target,
      index: entry.index,
      deleteCount: 1,
    })
    return entry.message
  }

  /** Return the first pending message by id across both queues. */
  get(messageId: string): DurableInboxMessage | undefined {
    return this._find(messageId)?.message
  }

  snapshot(): { nextTurn: readonly DurableInboxMessage[]; nextStep: readonly DurableInboxMessage[] } {
    return {
      nextTurn: [...this._nextTurn],
      nextStep: [...this._nextStep],
    }
  }

  private _find(messageId: string):
    | { list: DurableInboxMessage[]; target: DurableTarget; index: number; message: DurableInboxMessage }
    | undefined {
    for (const target of ['next-step', 'next-turn'] as const) {
      const list = target === 'next-step' ? this._nextStep : this._nextTurn
      const index = list.findIndex(message => message.id === messageId)
      if (index >= 0) return { list, target, index, message: list[index]! }
    }
    return undefined
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
      } else if (count > 0 && payload.index !== undefined) {
        list.splice(payload.index, Math.min(count, list.length - payload.index))
      }
      let insertedOffset = 0
      for (const item of payload.inserted ?? []) {
        const message: DurableInboxMessage = {
          id: item.id,
          ...(item.content !== undefined ? { text: item.content } : {}),
        }
        if (item.mode === 'steer') {
          list.unshift(message)
        } else {
          const at = payload.index === undefined
            ? list.length
            : Math.min(list.length, payload.index + insertedOffset)
          list.splice(at, 0, message)
          insertedOffset += 1
        }
      }
    }
  }
}
