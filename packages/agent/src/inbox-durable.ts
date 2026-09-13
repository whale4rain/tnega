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

function payloadOf(input: { text?: string; content?: unknown }): unknown | undefined {
  return input.content !== undefined ? input.content : undefined
}

export class DurableInbox {
  private _nextTurn: DurableInboxMessage[] = []
  private _nextStep: DurableInboxMessage[] = []
  private _operationTail: Promise<void> = Promise.resolve()

  constructor(private _session: SessionLog) {}

  get size(): number {
    return this._nextTurn.length + this._nextStep.length
  }

  async insert(input: { text?: string; content?: unknown }, target: DurableTarget = 'next-turn'): Promise<DurableInboxMessage> {
    return this._run(async () => {
      const message: DurableInboxMessage = {
        id: randomUUID(),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
      }
      const list = target === 'next-step' ? this._nextStep : this._nextTurn
      const index = list.length
      await this._session.append('agent/inbox/spliced', {
        target,
        index,
        inserted: [{
          id: message.id,
          content: contentOf(message),
          ...(payloadOf(message) !== undefined ? { payload: payloadOf(message) } : {}),
        }],
      })
      list.push(message)
      return message
    })
  }

  async steer(input: { text?: string; content?: unknown }): Promise<DurableInboxMessage> {
    return this._run(async () => {
      const message: DurableInboxMessage = {
        id: randomUUID(),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
      }
      await this._session.append('agent/inbox/spliced', {
        target: 'next-step',
        index: this._nextStep.length,
        inserted: [{
          id: message.id,
          content: contentOf(message),
          ...(payloadOf(message) !== undefined ? { payload: payloadOf(message) } : {}),
          mode: 'steer',
        }],
      })
      this._nextStep.push(message)
      return message
    })
  }

  async claim(): Promise<DurableInboxMessage | undefined> {
    return this._run(async () => {
      const steered = this._nextStep[0]
      if (steered) {
        await this._session.append('agent/inbox/spliced', {
          target: 'next-step',
          index: 0,
          deleteCount: 1,
        })
        this._nextStep.shift()
        return steered
      }
      const next = this._nextTurn[0]
      if (next) {
        await this._session.append('agent/inbox/spliced', {
          target: 'next-turn',
          index: 0,
          deleteCount: 1,
        })
        this._nextTurn.shift()
        return next
      }
      return undefined
    })
  }

  /**
   * Claim the complete proposed step batch: every pending next-step input plus
   * one next-turn message at a turn boundary. Returns an empty array when
   * nothing is pending.
   */
  async claimBatch(): Promise<DurableInboxMessage[]> {
    return this._run(async () => {
      const claimed = [...this._nextStep]
      const nextTurn = this._nextTurn[0]
      if (nextTurn) claimed.push(nextTurn)
      if (!claimed.length) return []
      const deleteCounts = { nextStep: this._nextStep.length, nextTurn: nextTurn ? 1 : 0 }
      await this._session.append('agent/inbox/spliced', { target: 'all', deleteCounts })
      this._nextStep.splice(0, deleteCounts.nextStep)
      this._nextTurn.splice(0, deleteCounts.nextTurn)
      return claimed
    })
  }

  /** Claim every input waiting for the next step, without consuming a turn. */
  async claimNextStep(): Promise<DurableInboxMessage[]> {
    return this._run(async () => {
      if (!this._nextStep.length) return []
      const claimed = [...this._nextStep]
      await this._session.append('agent/inbox/spliced', {
        target: 'next-step',
        index: 0,
        deleteCount: claimed.length,
      })
      this._nextStep.splice(0, claimed.length)
      return claimed
    })
  }

  async clear(): Promise<void> {
    return this._run(async () => {
      if (!this._nextTurn.length && !this._nextStep.length) return
      await this._session.append('agent/inbox/spliced', {
        target: 'all',
      })
      this._nextTurn = []
      this._nextStep = []
    })
  }

  /** Insert a message at an explicit target/index boundary. */
  async insertAt(
    input: { text?: string; content?: unknown },
    target: DurableTarget,
    index: number,
    mode: 'followup' | 'steer' = 'followup',
  ): Promise<DurableInboxMessage> {
    return this._run(async () => {
      const message: DurableInboxMessage = {
        id: randomUUID(),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
      }
      const list = target === 'next-step' ? this._nextStep : this._nextTurn
      const safeIndex = Math.max(0, Math.min(index, list.length))
      await this._session.append('agent/inbox/spliced', {
        target,
        index: safeIndex,
        inserted: [{
          id: message.id,
          content: contentOf(message),
          ...(payloadOf(message) !== undefined ? { payload: payloadOf(message) } : {}),
          mode,
        }],
      })
      list.splice(safeIndex, 0, message)
      return message
    })
  }

  /**
   * Replace one pending message by id. The old message is emitted as
   * discarded and the new one as inserted, matching the DSH inbox contract.
   */
  async replace(
    messageId: string,
    input: { text?: string; content?: unknown },
  ): Promise<DurableInboxMessage | undefined> {
    return this._run(async () => {
      const entry = this._find(messageId)
      if (!entry) return undefined
      const replacement: DurableInboxMessage = {
        id: randomUUID(),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
      }
      const target = entry.target
      const index = entry.index
      await this._session.append('agent/inbox/spliced', {
        target,
        index,
        deleteCount: 1,
        inserted: [{
          id: replacement.id,
          content: contentOf(replacement),
          ...(payloadOf(replacement) !== undefined
            ? { payload: payloadOf(replacement) }
            : {}),
        }],
      })
      entry.list.splice(index, 1, replacement)
      return replacement
    })
  }

  /** Remove one pending message by id. */
  async remove(messageId: string): Promise<DurableInboxMessage | undefined> {
    return this._run(async () => {
      const entry = this._find(messageId)
      if (!entry) return undefined
      await this._session.append('agent/inbox/spliced', {
        target: entry.target,
        index: entry.index,
        deleteCount: 1,
      })
      entry.list.splice(entry.index, 1)
      return entry.message
    })
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

  /** Keep the entire read → append → apply transition ordered, including claims. */
  private _run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this._operationTail.then(operation)
    this._operationTail = result.then(() => undefined, () => undefined)
    return result
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
      if (payload.target === 'all') {
        this._nextTurn.splice(0, payload.deleteCounts?.nextTurn ?? this._nextTurn.length)
        this._nextStep.splice(0, payload.deleteCounts?.nextStep ?? this._nextStep.length)
        continue
      }
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
          ...(item.payload !== undefined ? { content: item.payload } : {}),
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
