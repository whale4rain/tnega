import { describe, expect, it } from 'vitest'
import type { SessionEvent } from './types'
import { projectEvents } from './projectEvents'

function ev<T extends SessionEvent['type']>(
  type: T,
  payload: Extract<SessionEvent, { type: T }>['payload'],
  index: number,
): SessionEvent {
  return {
    id: `e${index}`,
    seq: index,
    ts: index,
    type,
    payload,
  } as SessionEvent
}

describe('projectEvents', () => {
  it('projects interrupted assistant messages and llm retry recovery', () => {
    const events: SessionEvent[] = [
      ev('turn/start', {}, 1),
      ev('user/message', { content: 'hello' }, 2),
      ev('assistant/message', { content: 'partial', interrupted: true }, 3),
      ev('llm/retry', {
        retryId: 'r1',
        retry: 1,
        delayMs: 500,
        failure: { name: 'ECONNRESET', message: 'socket reset' },
      }, 4),
      ev('llm/retry-started', { retryId: 'r1', retry: 1 }, 5),
      ev('assistant/message', { content: 'full' }, 6),
      ev('step/end', { index: 0, finishReason: 'stop' }, 7),
      ev('turn/end', { finishReason: 'stop' }, 8),
    ]

    const messages = projectEvents(events)

    expect(messages).toHaveLength(3)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hello' })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'partial',
      interrupted: true,
      retry: {
        retryId: 'r1',
        retry: 1,
        delayMs: 500,
        started: true,
        failure: { name: 'ECONNRESET', message: 'socket reset' },
      },
    })
    expect(messages[2]).toMatchObject({ role: 'assistant', content: 'full' })
    expect(messages[2]?.interrupted).toBeUndefined()
    expect(messages[2]?.retry).toBeUndefined()
    expect(messages[2]?.endState).toBeUndefined()
  })

  it('attaches typed cancellation to the interrupted assistant message', () => {
    const events: SessionEvent[] = [
      ev('turn/start', {}, 1),
      ev('user/message', { content: 'go' }, 2),
      ev('assistant/message', { content: 'half', interrupted: true }, 3),
      ev('step/end', {
        index: 0,
        finishReason: 'cancelled',
        interrupted: true,
        cancelCause: { type: 'user' },
      }, 4),
      ev('turn/end', {
        finishReason: 'cancelled',
        cancelCause: { type: 'user' },
      }, 5),
    ]

    const messages = projectEvents(events)

    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'half',
      interrupted: true,
      endState: {
        finishReason: 'cancelled',
        cancelCause: { type: 'user' },
      },
    })
  })

  it('projects a typed cancellation without an assistant message', () => {
    const events: SessionEvent[] = [
      ev('turn/start', {}, 1),
      ev('user/message', { content: 'go' }, 2),
      ev('turn/end', {
        finishReason: 'cancelled',
        cancelCause: { type: 'timeout', timeoutMs: 5000 },
      }, 3),
    ]

    const messages = projectEvents(events)

    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: 'system',
      content: '[cancel timeout 5000ms]',
      endState: {
        finishReason: 'cancelled',
        cancelCause: { type: 'timeout', timeoutMs: 5000 },
      },
    })
  })

  it('projects a retry with no partial content as a system marker', () => {
    const events: SessionEvent[] = [
      ev('turn/start', {}, 1),
      ev('user/message', { content: 'go' }, 2),
      ev('llm/retry', {
        retryId: 'r2',
        retry: 2,
        failure: { message: 'boom' },
      }, 3),
      ev('llm/retry-started', { retryId: 'r2', retry: 2 }, 4),
      ev('assistant/message', { content: 'ok' }, 5),
    ]

    const messages = projectEvents(events)

    expect(messages[1]).toMatchObject({
      role: 'system',
      content: '[retry 2]',
      retry: {
        retryId: 'r2',
        retry: 2,
        started: true,
        failure: { message: 'boom' },
      },
    })
  })

  it('scopes retry attachment to the current turn', () => {
    const events: SessionEvent[] = [
      ev('turn/start', {}, 1),
      ev('user/message', { content: 'one' }, 2),
      ev('assistant/message', { content: 'first' }, 3),
      ev('turn/end', { finishReason: 'stop' }, 4),
      ev('turn/start', {}, 5),
      ev('user/message', { content: 'two' }, 6),
      ev('assistant/message', { content: 'partial', interrupted: true }, 7),
      ev('llm/retry', {
        retryId: 'r3',
        retry: 1,
        failure: { message: 'x' },
      }, 8),
      ev('assistant/message', { content: 'second' }, 9),
      ev('turn/end', { finishReason: 'stop' }, 10),
    ]

    const messages = projectEvents(events)

    expect(messages[1]?.retry).toBeUndefined()
    expect(messages[3]?.retry).toMatchObject({ retryId: 'r3', retry: 1 })
    expect(messages[4]?.retry).toBeUndefined()
  })

  it('does not attach current-turn retry or end state to a previous assistant', () => {
    const events: SessionEvent[] = [
      ev('turn/start', {}, 1),
      ev('user/message', { content: 'one' }, 2),
      ev('assistant/message', { content: 'first' }, 3),
      ev('turn/end', { finishReason: 'stop' }, 4),
      ev('turn/start', {}, 5),
      ev('user/message', { content: 'two' }, 6),
      ev('llm/retry', {
        retryId: 'r4',
        retry: 1,
        failure: { message: 'x' },
      }, 7),
      ev('llm/retry-started', { retryId: 'r4', retry: 1 }, 8),
      ev('turn/end', {
        finishReason: 'cancelled',
        cancelCause: { type: 'user' },
      }, 9),
    ]

    const messages = projectEvents(events)

    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'first' })
    expect(messages[1]?.retry).toBeUndefined()
    expect(messages[1]?.endState).toBeUndefined()
    expect(messages[3]).toMatchObject({
      role: 'system',
      content: '[retry 1]',
      retry: { retryId: 'r4', retry: 1, started: true },
    })
    expect(messages[4]).toMatchObject({
      role: 'system',
      content: '[cancel user]',
      endState: { finishReason: 'cancelled', cancelCause: { type: 'user' } },
    })
  })
})
