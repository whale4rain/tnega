import type { AgentType, SessionSummary } from './types'

export interface WelcomeGreeting {
  /** The hello, by the time of day: "Good afternoon." */
  hello: string
  /** The question that invites the first message, by the kind of agent. */
  ask: string
}

const ASK: Record<AgentType, string> = {
  coding: 'What are we building?',
  work: 'What can I take off your plate?',
  general: 'What’s on your mind?',
}

/** The new-session greeting for a local hour (0–23) and the agent the session will run as. */
export function welcomeGreeting(hour: number, agentType: AgentType): WelcomeGreeting {
  const hello = hour < 5 || hour >= 23 ? 'Working late.'
    : hour < 12 ? 'Good morning.'
      : hour < 18 ? 'Good afternoon.'
        : 'Good evening.'
  return { hello, ask: ASK[agentType] }
}

/** How far the welcome cloud's eyes may move from rest, in its 64-unit drawing. */
export const EYE_REACH = 3

/**
 * Where the cloud's eyes look: an offset toward the pointer, reaching its full
 * length once the pointer is `range` pixels away and never past it, so the eyes
 * stay inside the cloud wherever the pointer goes.
 */
export function eyeOffset(dx: number, dy: number, range = 320): { x: number; y: number } {
  const distance = Math.hypot(dx, dy)
  if (distance < 1) return { x: 0, y: 0 }
  const reach = EYE_REACH * Math.min(1, distance / range)
  return { x: (dx / distance) * reach, y: (dy / distance) * reach * 0.7 }
}

/** The sessions a new session offers to pick up: the three most recently updated. */
export function recentSessions(sessions: readonly SessionSummary[], count = 3): SessionSummary[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, count)
}
