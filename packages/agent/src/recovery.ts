import { TOOL_NOT_STARTED, type SessionEvent } from '@tnega/session'
import type { LiveAgent } from './live.js'

/** Author name of the recovery input, so views can fold it away. */
export const RECOVERY_NUDGE_NAME = 'plugin:recover'

export const RECOVERY_NUDGE = 'The previous run was interrupted before it finished (the app stopped or crashed). Read the interrupted tool results above, then continue the task from where it stopped. A call marked TOOL_OUTCOME_UNKNOWN may already have taken effect: check its result before repeating it.'

/** A turn that a crash closed, as crash repair left it in the durable log. */
export interface InterruptedTurn {
  turn: number
  /**
   * Whether continuing is safe without asking: every cut-off tool call either
   * never started or is declared safe to repeat, and this turn was not itself
   * an automatic recovery.
   */
  safe: boolean
  /** Calls that may already have taken effect and were not safe to repeat. */
  uncertainCalls: string[]
}

/**
 * The latest turn if crash repair closed it and nothing has been queued since.
 * Repair closes a turn with `finishReason: 'interrupted'` and no error, reason
 * or cancel cause; cancellation and run errors never look like that.
 */
export function findInterruptedTurn(events: readonly SessionEvent[]): InterruptedTurn | undefined {
  let endIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'turn/start') return undefined
    if (event.type === 'agent/inbox/spliced' && event.payload.target !== 'all' && event.payload.inserted?.length) return undefined
    if (event.type === 'turn/end') {
      endIndex = index
      break
    }
  }
  const end = events[endIndex]
  if (end?.type !== 'turn/end') return undefined
  const payload = end.payload
  if (payload.finishReason !== 'interrupted' || payload.error || payload.reason || payload.cancelCause) return undefined

  let startIndex = endIndex
  while (startIndex >= 0) {
    const event = events[startIndex]!
    if (event.type === 'turn/start' && event.payload.turn === payload.turn) break
    startIndex -= 1
  }
  const turnEvents = events.slice(Math.max(0, startIndex), endIndex)
  const policies = new Map<string, string | undefined>()
  let fromRecovery = false
  const uncertainCalls: string[] = []
  for (const event of turnEvents) {
    if (event.type === 'user/message' && event.payload.name === RECOVERY_NUDGE_NAME) fromRecovery = true
    if (event.type === 'tool/call') policies.set(event.payload.id, event.payload.interruption)
    if (event.type !== 'tool/result' || event.payload.ok || event.payload.error?.name !== 'SessionInterruptedError') continue
    if (event.payload.error.message.startsWith(TOOL_NOT_STARTED)) continue
    if (policies.get(event.payload.toolCallId) === 'retry') continue
    uncertainCalls.push(event.payload.name)
  }
  return { turn: payload.turn, safe: !fromRecovery && !uncertainCalls.length, uncertainCalls }
}

/**
 * Queue one durable recovery input after a crash-closed turn, so the Agent
 * picks the task up again. Returns false when there is nothing to recover or
 * recovery was already queued; the queued input itself marks the turn handled.
 */
export async function recoverInterruptedTurn(agent: LiveAgent): Promise<boolean> {
  if (!findInterruptedTurn(await agent.session.read())) return false
  await agent.followup({ messages: [{ role: 'user', name: RECOVERY_NUDGE_NAME, content: RECOVERY_NUDGE }] })
  return true
}
