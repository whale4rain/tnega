import { readFile } from 'node:fs/promises'
import type { SessionEvent } from '@tnega/session'

import type { TrialTrace } from './types.js'

export async function readTrace(file: string): Promise<SessionEvent[]> {
  const text = await readFile(file, 'utf8')
  const events: SessionEvent[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    events.push(JSON.parse(trimmed) as SessionEvent)
  }
  return events
}

export async function deriveTraceMetrics(
  file: string,
  startedAt: number,
  endedAt: number,
  usage: { tokens?: number; cost?: number } = {},
): Promise<TrialTrace> {
  const events = await readTrace(file)
  let steps = 0
  let turns = 0
  let toolCalls = 0
  let toolErrors = 0
  let invalidToolCalls = 0
  let retries = 0
  let sawError = false
  let recoveredAfterError = false

  for (const event of events) {
    switch (event.type) {
      case 'tool/call':
        toolCalls += 1
        break
      case 'tool/result':
        if (event.payload.ok) {
          if (sawError) {
            recoveredAfterError = true
            sawError = false
          }
        } else {
          toolErrors += 1
          const name = event.payload.error?.name ?? ''
          if (
            name === 'ToolInputError'
            || name === 'ToolNotFoundError'
            || name === 'ToolAuthorizationError'
          ) {
            invalidToolCalls += 1
          }
          sawError = true
        }
        break
      case 'llm/retry':
      case 'llm/retry-started':
        retries += 1
        break
      case 'step/end':
        steps += 1
        break
      case 'turn/end':
        turns += 1
        break
      default:
        break
    }
  }

  return {
    file,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    metrics: {
      steps,
      turns,
      toolCalls,
      toolErrors,
      invalidToolCalls,
      retries,
      tokens: usage.tokens ?? 0,
      cost: usage.cost ?? 0,
      recoveredAfterError,
    },
  }
}
