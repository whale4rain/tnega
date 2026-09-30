import type { AgentRunCompletedEvent } from '@tnega/agent'
import type { Context } from '@tnega/core'

/** Persists presentation metadata; never replaces model-visible messages. */
export const runSummary = {
  name: 'run-summary',
  apply(ctx: Context): void {
    ctx.on('agent/run-completed', async ({ session, result, signal }: AgentRunCompletedEvent) => {
      if (signal?.aborted || result.finishReason !== 'stop' || result.turn === undefined) return
      const events = await session.read()
      const end = events.findLastIndex(event => event.type === 'turn/end' && event.payload.turn === result.turn)
      if (end < 0) return
      const endEvent = events[end]
      if (endEvent?.type !== 'turn/end' || endEvent.payload.finishReason !== 'stop'
        || (endEvent.payload.reason && endEvent.payload.reason.kind !== 'completed')
        || endEvent.payload.interrupted || endEvent.payload.cancelCause || endEvent.payload.error) return
      const start = events.findLastIndex((event, index) => index < end && event.type === 'turn/start' && event.payload.turn === result.turn)
      if (start < 0) return
      const messages = events.slice(start + 1, end).filter(event => event.type === 'assistant/message')
      const source = messages.at(-1)
      if (source?.type !== 'assistant/message' || source.payload.interrupted
        || source.payload.toolCalls?.length || !source.payload.content.trim()) return
      if (events.some(event => event.type === 'meta' && event.payload.kind === 'run/summary'
        && event.payload.turn === result.turn)) return
      if (signal?.aborted) return
      await session.append('meta', {
        kind: 'run/summary',
        turn: result.turn,
        summary: source.payload.content,
        sourceMessageId: source.id,
      })
      await session.flush()
    })
  },
}
