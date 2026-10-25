import type { Context } from '@tnega/core'
import type { AgentInput } from './types.js'

/**
 * Naming an agent without holding a handle to it.
 *
 * A loop guard or a continuation nudge is mounted in the composition that owns
 * the scope, but that scope does not always own an {@link AgentRegistry}: a
 * headless `tnega run` has exactly one Agent and no registry at all. Both
 * plugins need the same two verbs — "insert this at the next step of that
 * agent's turn" and "stage this for its next step" — so they reach the agent by
 * id through this seam instead of through a concrete registry.
 *
 * The seam is provided once per scope: the AgentRegistry where one exists,
 * otherwise the single `agent` service.
 */
export interface AgentSteerService {
  /** Whether this scope can reach that agent at all. */
  has(agentId: string): boolean
  /** Insert input at the nearest step boundary of the agent's running turn. */
  steer(agentId: string, input: AgentInput): Promise<void>
  /** Stage model-visible input for the next step without waking idle work. */
  inject(agentId: string, input: AgentInput): Promise<void>
}

/**
 * Register the seam in this scope. The first provider wins, so a composition
 * that mounts both an AgentRegistry and a single `agent` service keeps the
 * registry (the live path) and never double-registers the `ctx` key.
 */
export function provideAgentSteer(ctx: Context, service: AgentSteerService): void {
  if (ctx.get('agentSteer', false) !== undefined) return
  ctx.provide('agentSteer', service)
}
