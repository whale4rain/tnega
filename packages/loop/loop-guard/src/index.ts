import { createHash } from 'node:crypto'
import type { Context } from '@tnega/core'
import { renderToolResult } from '@tnega/session'
import type { ToolResult } from '@tnega/tools'
import type {
  AgentContextCompactedEvent,
  AgentPreStepEvent,
  AgentRequestEvent,
  AgentStepEndEvent,
  AgentStepLimitsEvent,
  AgentTurnStartEvent,
  LLMToolCall,
} from '@tnega/agent'

/**
 * Author names of the guard's messages, so views can tell them apart and fold
 * them. Every one starts with {@link LOOP_GUARD_NAME}.
 */
export const LOOP_GUARD_NAME = 'plugin:loop-guard'
export const LOOP_GUARD_REFLECT_NAME = 'plugin:loop-guard:reflect'
export const LOOP_GUARD_PARK_NAME = 'plugin:loop-guard:park'
export const LOOP_GUARD_ATTEMPTS_NAME = 'plugin:loop-guard:attempts'

/**
 * Tools whose successful call changes the world the agent works on: a file,
 * an artifact, the plan, the goal, memory or a message to someone. A new call
 * to one of these is progress; repeating the identical call is not. `shell`
 * is here because agents edit, build and commit through it: a new command
 * counts, rerunning the same one (the same test run) does not.
 */
export const DEFAULT_PROGRESS_TOOLS: readonly string[] = [
  'write_file', 'shell',
  // Names that MCP servers and other tool sets commonly use for edits.
  'edit_file', 'apply_patch',
  'office_create', 'office_edit', 'skill',
  'publish_artifact', 'update_checklist', 'update_goal',
  'write_memory', 'remember_global',
  'send_project_message', 'send_thread_message', 'send_agent_message', 'spawn_thread', 'spawn_subagent',
  'react_to_message', 'ask_user_question',
]

export interface LoopGuardConfig {
  /** Steps a turn may take without progress before the watchdog fires (default 30). */
  stallSteps?: number
  /** How many recent tool calls the repeat detectors look at (default 12). */
  window?: number
  /** Same call with the same result this many times in the window (default 3). */
  sameResult?: number
  /** Same call, whatever it returned, this many times in the window (default 6). */
  sameCall?: number
  /** Same error this many times in a row (default 3). */
  sameError?: number
  /** Same assistant message this many steps in a row (default 3). */
  sameMessage?: number
  /** Steps after an escalation before the next level may fire (default 3). */
  grace?: number
  /**
   * Soft cap on tokens one turn may spend: uncached prompt plus output, as the
   * provider reported them (default 4,000,000; 0 turns it off). Reaching it
   * parks the turn and asks the user instead of killing the run.
   */
  maxTurnTokens?: number
  /** Soft cap on one turn's wall-clock time in ms (default 2 hours; 0 turns it off). */
  maxTurnMs?: number
  /**
   * Hard backstop for runs whose caller set no limit (default 500 steps). The
   * watchdog bounds stalls; this only bounds a run that keeps moving forever.
   */
  backstopSteps?: number
  /** Tool names that count as progress (default {@link DEFAULT_PROGRESS_TOOLS}). */
  progressTools?: readonly string[]
  /** Failed attempts kept per agent and re-sent after a compaction (default 10). */
  attempts?: number
  /** Clock, for tests. */
  now?: () => number
}

/** What a detector saw, in words the nudge can quote back to the model. */
export interface LoopSignal {
  kind: 'same-result' | 'same-call' | 'same-error' | 'cycle' | 'same-message' | 'stall' | 'tokens' | 'time'
  detail: string
}

/** One tool call, as the detectors compare it. */
export interface LoopEntry {
  action: string
  outcome: string
  /** Normalized error, when the call failed. */
  error?: string
  label: string
}

interface TurnState {
  turn: number
  startedAt: number
  tokens: number
  entries: LoopEntry[]
  messages: string[]
  /** Actions of progress tools already seen this turn. */
  progressSeen: Set<string>
  /** Outcomes already seen this turn: a step that sees none new learned nothing. */
  outcomesSeen: Set<string>
  /** How often each error signature has come up this turn. */
  errors: Map<string, number>
  stepsSinceProgress: number
  level: number
  lastFiredStep: number
  parked: boolean
}

interface AgentState {
  turn?: TurnState
  attempts: string[]
}

const DEFAULTS = {
  stallSteps: 30,
  window: 12,
  sameResult: 3,
  sameCall: 6,
  sameError: 3,
  sameMessage: 3,
  grace: 3,
  maxTurnTokens: 4_000_000,
  maxTurnMs: 2 * 60 * 60 * 1000,
  backstopSteps: 500,
  attempts: 10,
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/**
 * Key order doesn't make two calls different. String contents are kept as
 * they are: a write that only fixes indentation is a different write.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    return Object.fromEntries(entries.map(([key, item]) => [key, normalize(item)]))
  }
  return value
}

function argsText(call: LLMToolCall): string {
  return JSON.stringify(normalize(call.arguments ?? {})) ?? ''
}

function label(call: LLMToolCall): string {
  const args = argsText(call)
  return `${call.name}(${args.length > 80 ? `${args.slice(0, 77)}...` : args})`
}

/** The error without the parts that change between tries: numbers, ids, paths' line numbers. */
function errorSignature(result: ToolResult): string | undefined {
  if (result.ok) return undefined
  const message = (result.error?.message ?? '').replace(/0x[0-9a-f]+|\d+/gi, '#').replace(/\s+/g, ' ').trim()
  return `${result.error?.name ?? 'Error'}: ${message.slice(0, 200)}`
}

function entryOf(call: LLMToolCall, result: ToolResult): LoopEntry {
  const action = hash(`${call.name}\u0000${argsText(call)}`)
  const error = errorSignature(result)
  return {
    action,
    outcome: hash(`${action}\u0000${renderToolResult(result)}`),
    ...(error ? { error } : {}),
    label: label(call),
  }
}

function count<T>(items: readonly T[], item: T): number {
  return items.reduce((total, current) => total + (current === item ? 1 : 0), 0)
}

/**
 * Whether the sequence ends in a cycle of period 2 or 3 repeated `times`
 * times: A B A B (A B) ... The period must hold more than one distinct item,
 * so a plain repeat is left to the repeat detectors.
 */
function cycle(sequence: readonly string[], times: number): number | undefined {
  for (const period of [2, 3]) {
    const span = period * times
    if (sequence.length < span) continue
    const tail = sequence.slice(-span)
    const unit = tail.slice(0, period)
    if (new Set(unit).size < 2) continue
    if (tail.every((item, index) => item === unit[index % period])) return period
  }
  return undefined
}

/** The detectors, over the current turn. The first that fires wins. */
export function detectLoop(
  entries: readonly LoopEntry[],
  messages: readonly string[],
  config: Required<Pick<LoopGuardConfig, 'window' | 'sameResult' | 'sameCall' | 'sameError' | 'sameMessage'>>,
): LoopSignal | undefined {
  const recent = entries.slice(-config.window)
  const last = recent.at(-1)
  if (last) {
    // Same call, same result: the agent learns nothing new.
    const sameResult = count(recent.map(entry => entry.outcome), last.outcome)
    if (sameResult >= config.sameResult) {
      return { kind: 'same-result', detail: `You have called ${last.label} ${sameResult} times and got the same result each time.` }
    }
    const errors = recent.slice(-config.sameError)
    if (last.error && errors.length >= config.sameError && errors.every(entry => entry.error === last.error)) {
      return { kind: 'same-error', detail: `The last ${errors.length} tool calls all failed with the same error: ${last.error}` }
    }
    const pairs = cycle(recent.map(entry => entry.outcome), 2)
      ?? cycle(recent.map(entry => entry.action), 3)
    if (pairs) {
      const unit = recent.slice(-pairs).map(entry => entry.label).join(' → ')
      return { kind: 'cycle', detail: `You are going round in a cycle: ${unit}, again and again.` }
    }
    const sameCall = count(recent.map(entry => entry.action), last.action)
    if (sameCall >= config.sameCall) {
      return { kind: 'same-call', detail: `You have called ${last.label} ${sameCall} times in your last ${recent.length} tool calls.` }
    }
  }
  const said = messages.slice(-config.sameMessage)
  if (said.length >= config.sameMessage && said[0] && said.every(text => text === said[0])) {
    return { kind: 'same-message', detail: `Your last ${said.length} messages were the same.` }
  }
  return undefined
}

export function nudgeText(signal: LoopSignal): string {
  if (signal.kind === 'stall') {
    return `${signal.detail} If you are still getting somewhere, record it (update the plan, checklist or a file) and carry on. If not, try a different approach, or ask the user or report what is blocking you.`
  }
  return `${signal.detail} Repeating it will not give you anything new. Try a different approach, or if you are blocked, say so: ask the user or report what is stopping you.`
}

export function reflectText(signal: LoopSignal): string {
  return `${signal.detail} You are still not making progress. Before your next tool call, write a short reflection: what you have tried, why it did not work, and what you will do differently now. If there is nothing different left to try, stop and tell the user you are blocked.`
}

export function parkText(signal: LoopSignal): string {
  const why = signal.kind === 'tokens' || signal.kind === 'time'
    ? signal.detail
    : `${signal.detail} You kept at it after being asked to change approach.`
  return `Stop here: this turn is paused. ${why} Do not call more tools. Reply to the user with what is done, where you got stuck and what you tried, and what you need from them to continue.`
}

/**
 * Watches each Agent turn for stalls instead of capping its length. A long
 * turn is fine while it keeps moving; what it catches is a turn that repeats
 * itself, cycles, keeps failing the same way, or goes many steps without
 * progress. It then escalates: a nudge that names the repeat, a request to
 * reflect and re-plan, and finally it parks the turn: tools are withdrawn and
 * the model reports to the user. Failed attempts are kept per agent and
 * re-sent after a compaction, so a summary does not make the agent retry them.
 *
 * It also lifts the default step cap to a high backstop for runs whose caller
 * set none, and parks a turn that crosses a soft token or wall-clock limit.
 */
export const loopGuard = {
  name: 'loop-guard',
  apply(ctx: Context, config: LoopGuardConfig = {}): void {
    const options = { ...DEFAULTS, ...config }
    const now = config.now ?? Date.now
    const progressTools = new Set(config.progressTools ?? DEFAULT_PROGRESS_TOOLS)
    const agents = new Map<string, AgentState>()

    const stateOf = (agentId: string): AgentState => {
      let state = agents.get(agentId)
      if (!state) {
        state = { attempts: [] }
        agents.set(agentId, state)
        // Forget the oldest agents; a resident host only runs a few at once.
        for (const old of agents.keys()) {
          if (agents.size <= 256) break
          agents.delete(old)
        }
      }
      return state
    }
    const freshTurn = (turn: number): TurnState => ({
      turn,
      startedAt: now(),
      tokens: 0,
      entries: [],
      messages: [],
      progressSeen: new Set(),
      outcomesSeen: new Set(),
      errors: new Map(),
      stepsSinceProgress: 0,
      level: 0,
      lastFiredStep: -Infinity,
      parked: false,
    })
    const progressed = (turn: TurnState): void => {
      turn.stepsSinceProgress = 0
      turn.entries = []
      turn.messages = []
      turn.level = 0
      // Someone answered or the work moved on: the turn may use tools again.
      turn.parked = false
    }
    const remember = (state: AgentState, attempt: string): void => {
      state.attempts = [...state.attempts.filter(item => item !== attempt), attempt].slice(-options.attempts)
    }

    ctx.on('agent/step-limits', async (_event: AgentStepLimitsEvent, next: () => Promise<AgentStepLimitsEvent>) => {
      // Later listeners decide first; the backstop only fills what stays unset.
      const limits = await next()
      if (!limits.agentId || options.backstopSteps <= 0) return limits
      return {
        ...limits,
        maxSteps: limits.maxSteps ?? options.backstopSteps,
        maxTurns: limits.maxTurns ?? options.backstopSteps,
      }
    })

    ctx.on('agent/turn-start', (event: AgentTurnStartEvent) => {
      if (!event.agentId) return
      // A new turn starts with whatever the user just said: a clean slate,
      // including the attempts, which belong to the task that was running.
      const state = stateOf(event.agentId)
      delete state.turn
      state.attempts = []
    })

    ctx.on('agent/pre-step', async (event: AgentPreStepEvent, next: () => unknown) => {
      if (event.agentId) {
        const state = stateOf(event.agentId)
        const turn = event.turn ?? 0
        if (!state.turn || state.turn.turn !== turn) state.turn = freshTurn(turn)
        // Someone answered mid-turn (the user, or another agent in a project):
        // new information, so the stall count starts over. The guard's own
        // messages and the harness's nudges don't count.
        const fromSomeone = event.claimedMessages.some(message => message.role === 'user'
          && !(message.name ?? '').startsWith('plugin:'))
        if (fromSomeone && event.index > 0) progressed(state.turn)
      }
      return next()
    })

    ctx.on('agent/request', async (_event: AgentRequestEvent, next: () => Promise<AgentRequestEvent>) => {
      const request = await next()
      const turn = request.agentId ? agents.get(request.agentId)?.turn : undefined
      // A parked turn only reports: no more tools.
      return turn?.parked && request.tools.length ? { ...request, tools: [] } : request
    })

    ctx.on('agent/step-end', async (event: AgentStepEndEvent) => {
      // An observer must never fail the turn it watches.
      try {
        await onStepEnd(event)
      } catch (error) {
        ctx.logger.warn(`loop guard skipped a step: ${String(error)}`)
      }
    })

    async function onStepEnd(event: AgentStepEndEvent): Promise<void> {
      if (!event.agentId) return
      const state = stateOf(event.agentId)
      if (!state.turn || state.turn.turn !== event.turn) state.turn = freshTurn(event.turn)
      const turn = state.turn
      if (turn.parked) return

      const usage = event.completion.usage
      if (usage) turn.tokens += Math.max(0, usage.promptTokens - (usage.cachedTokens ?? 0)) + usage.completionTokens

      let moved = false
      let learned = false
      for (const { call, result } of event.calls) {
        const entry = entryOf(call, result)
        if (result.ok && progressTools.has(call.name) && !turn.progressSeen.has(entry.action)) {
          turn.progressSeen.add(entry.action)
          moved = true
        }
        if (!turn.outcomesSeen.has(entry.outcome)) {
          turn.outcomesSeen.add(entry.outcome)
          learned = true
        }
        if (entry.error) {
          // A one-off failure is ordinary exploration; one that comes back is worth keeping.
          const seen = (turn.errors.get(entry.error) ?? 0) + 1
          turn.errors.set(entry.error, seen)
          if (seen === 2) remember(state, `${entry.label} failed: ${entry.error}`)
        }
        turn.entries.push(entry)
      }
      // The same words over a step that learned something are filler, not a loop.
      const content = (event.completion.content ?? '').replace(/\s+/g, ' ').trim()
      if (learned) turn.messages = []
      else if (content) turn.messages.push(hash(content))
      if (turn.entries.length > options.window * 4) turn.entries = turn.entries.slice(-options.window * 2)
      if (turn.messages.length > options.sameMessage * 4) turn.messages = turn.messages.slice(-options.sameMessage)

      if (moved) progressed(turn)
      else turn.stepsSinceProgress += 1

      // No tool calls: the turn is ending on its own. Leave it be.
      if (!event.calls.length || event.signal?.aborted) return

      const limit = budgetSignal(turn)
      const signal = limit ?? detectLoop(turn.entries, turn.messages, options) ?? stallSignal(turn)
      if (!signal) return
      if (!limit && event.index - turn.lastFiredStep < options.grace) return

      const steer = ctx.get('agentSteer', false)
      if (!steer?.has(event.agentId)) return
      turn.level = limit ? 3 : turn.level + 1
      turn.lastFiredStep = event.index
      // The pattern must show up again before the next level fires.
      turn.entries = []
      turn.messages = []
      turn.stepsSinceProgress = 0
      if (signal.kind !== 'tokens' && signal.kind !== 'time') remember(state, signal.detail)

      if (turn.level >= 3) {
        turn.parked = true
        await steer.steer(event.agentId, { messages: [{ role: 'user', name: LOOP_GUARD_PARK_NAME, content: parkText(signal) }] })
      } else if (turn.level === 2) {
        await steer.steer(event.agentId, { messages: [{ role: 'user', name: LOOP_GUARD_REFLECT_NAME, content: reflectText(signal) }] })
      } else {
        await steer.steer(event.agentId, { messages: [{ role: 'user', name: LOOP_GUARD_NAME, content: nudgeText(signal) }] })
      }
    }

    ctx.on('agent/context-compacted', async (event: AgentContextCompactedEvent) => {
      if (!event.agentId) return
      const state = agents.get(event.agentId)
      if (!state?.attempts.length) return
      const steer = ctx.get('agentSteer', false)
      if (!steer?.has(event.agentId)) return
      // A summary tends to drop what didn't work; say it again so it isn't retried.
      const list = state.attempts.map(item => `- ${item}`).join('\n')
      await steer.inject(event.agentId, { messages: [{
        role: 'user',
        name: LOOP_GUARD_ATTEMPTS_NAME,
        content: `Kept across the summary: these attempts already failed or went in circles in this task. Do not repeat them unless something has changed.\n${list}`,
      }] })
    })

    function budgetSignal(turn: TurnState): LoopSignal | undefined {
      if (options.maxTurnTokens > 0 && turn.tokens >= options.maxTurnTokens) {
        return { kind: 'tokens', detail: `This turn has used about ${Math.round(turn.tokens / 1000)}k tokens, the limit set for one turn.` }
      }
      const elapsed = now() - turn.startedAt
      if (options.maxTurnMs > 0 && elapsed >= options.maxTurnMs) {
        return { kind: 'time', detail: `This turn has run for ${Math.round(elapsed / 60_000)} minutes, the limit set for one turn.` }
      }
      return undefined
    }

    function stallSignal(turn: TurnState): LoopSignal | undefined {
      // After a first warning, the watchdog looks again sooner.
      const threshold = turn.level > 0 ? Math.ceil(options.stallSteps / 2) : options.stallSteps
      if (turn.stepsSinceProgress < threshold) return undefined
      return {
        kind: 'stall',
        detail: `You have taken ${turn.stepsSinceProgress} steps without changing anything: no file, plan, checklist or message.`,
      }
    }
  },
}
