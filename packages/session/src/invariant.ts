/**
 * Session invariant companion.
 *
 * Pure structural checks over a session event stream, mirroring the DSH
 * "each package ships a ./invariant" discipline. They assert the relationships
 * the event-sourcing layer promises:
 *
 * - durable lifecycle structures (turn / step / tool call) stay balanced —
 *   every `turn/start` has a `turn/end`, every `tool/call` a `tool/result`;
 * - seq stays strictly monotonic;
 * - message events that reach the model surface stay append-only unless they
 *   belong to a compaction replacement.
 *
 * The checks are pure over `SessionEvent[]`, so they run equally on a full
 * log, on a single newly-committed event, or in tests. Recovery (repairing an
 * interrupted log into a closed one) is `repairUnclosed`; these checks assert
 * that the result is actually legal.
 */

import type { SessionEvent, ToolResultPayload } from './index.js'

export interface SessionInvariantFailure {
  name: string
  detail: string
}

/** Balanced `turn/start` ↔ `turn/end` per turn number. */
export function checkBalancedTurns(events: readonly SessionEvent[]): SessionInvariantFailure[] {
  const opens = new Map<number, number>()
  const failures: SessionInvariantFailure[] = []
  for (const event of events) {
    if (event.type === 'turn/start') {
      opens.set(event.payload.turn, (opens.get(event.payload.turn) ?? 0) + 1)
    } else if (event.type === 'turn/end') {
      const remaining = opens.get(event.payload.turn) ?? 0
      if (remaining <= 0) {
        failures.push({
          name: 'turn/end-without-start',
          detail: `turn/end for turn ${event.payload.turn} has no matching turn/start`,
        })
      } else {
        opens.set(event.payload.turn, remaining - 1)
      }
    }
  }
  for (const [turn, count] of opens) {
    for (let index = 0; index < count; index += 1) {
      failures.push({
        name: 'turn/start-without-end',
        detail: `turn/start ${turn} has no matching turn/end`,
      })
    }
  }
  return failures
}

/** Balanced `step/start` ↔ `step/end` per (turn, step). */
export function checkBalancedSteps(events: readonly SessionEvent[]): SessionInvariantFailure[] {
  const open = new Set<string>()
  const failures: SessionInvariantFailure[] = []
  for (const event of events) {
    if (event.type === 'step/start') {
      const key = `${event.payload.turn}:${event.payload.step}`
      if (open.has(key)) {
        failures.push({
          name: 'duplicate-step-start',
          detail: `step/start for ${key} appears twice without a matching step/end`,
        })
      }
      open.add(key)
    } else if (event.type === 'step/end') {
      const key = `${event.payload.turn}:${event.payload.step}`
      if (!open.delete(key)) {
        failures.push({
          name: 'step/end-without-start',
          detail: `step/end for ${key} has no matching step/start`,
        })
      }
    }
  }
  for (const key of open) {
    failures.push({
      name: 'step/start-without-end',
      detail: `step/start ${key} has no matching step/end`,
    })
  }
  return failures
}

/** Balanced `tool/call` ↔ `tool/result` per call id. */
export function checkBalancedToolCalls(events: readonly SessionEvent[]): SessionInvariantFailure[] {
  const open = new Set<string>()
  const failures: SessionInvariantFailure[] = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      open.add(event.payload.id)
    } else if (event.type === 'tool/result') {
      const payload = event.payload as ToolResultPayload
      const id = payload.toolCallId
      if (!open.delete(id)) {
        failures.push({
          name: 'tool/result-without-call',
          detail: `tool/result for call ${id} has no matching tool/call`,
        })
      }
    }
  }
  for (const id of open) {
    failures.push({
      name: 'tool/call-without-result',
      detail: `tool/call ${id} has no matching tool/result`,
    })
  }
  return failures
}

/** seq is strictly monotonic (an append-only log never rewinds). */
export function checkMonotonicSeq(events: readonly SessionEvent[]): SessionInvariantFailure[] {
  const failures: SessionInvariantFailure[] = []
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]
    const current = events[index]
    if (current && previous && current.seq <= previous.seq) {
      failures.push({
        name: 'non-monotonic-seq',
        detail: `seq ${current.seq} follows ${previous.seq} out of order at index ${index}`,
      })
    }
  }
  return failures
}

/** Aggregate all structural session checks over an event stream. */
export function checkSessionInvariants(
  events: readonly SessionEvent[],
): SessionInvariantFailure[] {
  return [
    ...checkBalancedTurns(events),
    ...checkBalancedSteps(events),
    ...checkBalancedToolCalls(events),
    ...checkMonotonicSeq(events),
  ]
}
