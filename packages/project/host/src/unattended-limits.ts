import type { LiveAgent } from '@tnega/agent'
import type { Context } from '@tnega/core'
import type { SessionEvent } from '@tnega/session'

/**
 * Limits for turns nobody watches (v2 server MVP §4.7): on a server a
 * Project thread or a routine runs with no window open, so a turn that loops
 * or runs long must end by itself. The loop guard and the continuation nudge
 * still apply, and nothing that asks is approved on its own.
 */
export interface UnattendedLimits {
  /** Longest a turn may run. Default 60 minutes. */
  turnMs?: number
  /** Most tokens (prompt + completion) one turn of a routine's thread may use. Default 400,000. */
  routineTokens?: number
}

export const DEFAULT_UNATTENDED_TURN_MS = 60 * 60_000
export const DEFAULT_ROUTINE_TOKENS = 400_000

/** Why a limit ended a turn, for the thread's state. */
export type LimitHit = { kind: 'time'; turnMs: number } | { kind: 'tokens'; used: number; budget: number }

export interface WatchedTurns {
  /** The agent to stop; looked up when a limit is hit. */
  agent: () => LiveAgent | undefined
  /** Whether this thread runs a routine; asked at the start of each turn. */
  isRoutine: () => Promise<boolean>
  /** Called once the turn was stopped. */
  onLimit: (hit: LimitHit) => void
}

function usageTokens(event: SessionEvent): number {
  if (event.type !== 'assistant/message') return 0
  const usage: unknown = Reflect.get(event.payload, 'usage')
  if (typeof usage !== 'object' || usage === null) return 0
  const prompt: unknown = Reflect.get(usage, 'promptTokens')
  const completion: unknown = Reflect.get(usage, 'completionTokens')
  return (typeof prompt === 'number' ? prompt : 0) + (typeof completion === 'number' ? completion : 0)
}

/** Watch one agent's turns and stop a turn that passes a limit. Undone with the agent's scope. */
export function limitUnattendedTurns(agentCtx: Context, limits: UnattendedLimits, watched: WatchedTurns): void {
  const turnMs = limits.turnMs ?? DEFAULT_UNATTENDED_TURN_MS
  const routineTokens = limits.routineTokens ?? DEFAULT_ROUTINE_TOKENS
  let timer: NodeJS.Timeout | undefined
  let budget: number | undefined
  let used = 0
  let turn = 0
  const stop = (hit: LimitHit): void => {
    const agent = watched.agent()
    if (!agent || agent.status !== 'running') return
    agent.cancel(hit.kind === 'time'
      ? { type: 'timeout', timeoutMs: hit.turnMs }
      : { type: 'abort', message: `used ${hit.used} tokens, over this routine's budget of ${hit.budget}` })
    watched.onLimit(hit)
  }
  const end = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    budget = undefined
  }
  const off = agentCtx.on('session/event', (event: SessionEvent) => {
    if (event.type === 'turn/start') {
      end()
      used = 0
      const current = ++turn
      timer = setTimeout(() => stop({ kind: 'time', turnMs }), turnMs)
      timer.unref()
      void watched.isRoutine().then(routine => {
        if (routine && turn === current) budget = routineTokens
      }, () => undefined)
      return
    }
    if (event.type === 'turn/end') {
      end()
      return
    }
    const tokens = usageTokens(event)
    if (!tokens) return
    used += tokens
    if (budget !== undefined && used > budget) stop({ kind: 'tokens', used, budget })
  })
  agentCtx.fiber.effect(() => () => { end(); off() }, 'unattended-limits')
}
