import type { CostEstimate } from '@tnega/usage'
import {
  costList,
  emptyComposition,
  roundComposition,
  scaleInto,
  type Composition,
  type ContextTiming,
  type SessionContextReport,
} from './report.js'

export const INSIGHTS_RANGES = ['today', '7d', '30d', 'all'] as const
export type InsightsRange = typeof INSIGHTS_RANGES[number]

export function isInsightsRange(value: unknown): value is InsightsRange {
  return INSIGHTS_RANGES.some(range => range === value)
}

/** A session's place in the workspace: a plain session or a Project thread. */
export interface InsightsSource {
  id: string
  kind: 'session' | 'thread'
  projectId?: string
  threadId?: string
  report: SessionContextReport
}

export interface InsightsSession {
  id: string
  kind: 'session' | 'thread'
  projectId?: string
  threadId?: string
  title: string
  model?: string
  updatedAt: number
  lastMessage?: string
  window: number
  current: SessionContextReport['current']
  /** Figures below cover the picked range. */
  turns: number
  steps: number
  tokens: number
  cost?: CostEstimate[]
  /** Local dates (YYYY-MM-DD) with at least one model request, all time. */
  days: string[]
}

export interface InsightsDay {
  date: string
  tokens: number
  steps: number
  cost?: CostEstimate[]
}

export interface ContextInsights {
  range: InsightsRange
  /** Start of the range; absent for all time. */
  from?: number
  generatedAt: number
  sessionCount: number
  activeSessions: number
  totals: {
    promptTokens: number
    completionTokens: number
    cachedTokens: number
    cacheHitRate?: number
    cost?: CostEstimate[]
    /** Active sessions with at least one priced request. */
    pricedSessions: number
    turns: number
    steps: number
    toolCalls: number
  }
  billed: { composition: Composition; output: number }
  timing: ContextTiming
  /** The last seven days, oldest first, whatever the range. */
  week: InsightsDay[]
  /** The last twelve weeks, oldest first, whatever the range. */
  activity: InsightsDay[]
  sessions: InsightsSession[]
}

export function localDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function startOfDay(timestamp: number, daysBack = 0): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  // setDate keeps a DST day one calendar day long.
  date.setDate(date.getDate() - daysBack)
  return date.getTime()
}

export function rangeStart(range: InsightsRange, now: number): number | undefined {
  switch (range) {
    case 'today': return startOfDay(now)
    case '7d': return startOfDay(now, 6)
    case '30d': return startOfDay(now, 29)
    case 'all': return undefined
  }
}

function lastDays(count: number, now: number): InsightsDay[] {
  return Array.from({ length: count }, (_, index) => ({ date: localDate(startOfDay(now, count - 1 - index)), tokens: 0, steps: 0 }))
}

function addCost(into: Map<string, number>, cost: CostEstimate | undefined): void {
  if (cost) into.set(cost.currency, (into.get(cost.currency) ?? 0) + cost.amount)
}

/** Roll session reports up into the workspace view for one range. */
export function contextInsights(sources: readonly InsightsSource[], range: InsightsRange, now = Date.now()): ContextInsights {
  const from = rangeStart(range, now)
  const inRange = (ts: number) => from === undefined || ts >= from
  const week = lastDays(7, now)
  const activity = lastDays(84, now)
  const weekIndex = new Map(week.map((day, index) => [day.date, index]))
  const activityIndex = new Map(activity.map((day, index) => [day.date, index]))
  const weekCosts = week.map(() => new Map<string, number>())

  const billed = emptyComposition()
  const costs = new Map<string, number>()
  const timing: ContextTiming = { activeMs: 0, waitingMs: 0, thinkingMs: 0, respondingMs: 0, toolMs: 0, otherMs: 0, modelCalls: 0, toolRuns: 0 }
  const totals: ContextInsights['totals'] = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, pricedSessions: 0, turns: 0, steps: 0, toolCalls: 0 }
  let cacheBase = 0
  let output = 0
  const sessions: InsightsSession[] = []

  for (const source of sources) {
    const { report } = source
    const days = new Set<string>()
    const sessionCosts = new Map<string, number>()
    let steps = 0
    let tokens = 0
    let priced = false
    let busy = 0
    for (const step of report.steps) {
      const date = localDate(step.ts)
      days.add(date)
      const all = step.promptTokens + step.completionTokens
      const w = weekIndex.get(date)
      if (w !== undefined) {
        week[w]!.tokens += all
        week[w]!.steps += 1
        addCost(weekCosts[w]!, step.cost)
      }
      const a = activityIndex.get(date)
      if (a !== undefined) {
        activity[a]!.tokens += all
        activity[a]!.steps += 1
      }
      if (!inRange(step.ts)) continue
      steps += 1
      tokens += all
      scaleInto(billed, step.estimate, step.promptTokens)
      output += step.completionTokens
      totals.promptTokens += step.promptTokens
      totals.completionTokens += step.completionTokens
      if (step.cachedTokens !== undefined) { totals.cachedTokens += step.cachedTokens; cacheBase += step.promptTokens }
      if (step.cost) { priced = true; addCost(costs, step.cost); addCost(sessionCosts, step.cost) }
      totals.toolCalls += step.toolCalls
      timing.modelCalls += 1
      timing.waitingMs += step.timing.waitingMs
      timing.thinkingMs += step.timing.thinkingMs
      timing.respondingMs += step.timing.respondingMs
      timing.toolMs += step.timing.toolMs
      timing.toolRuns += step.timing.toolRuns
      busy += step.timing.waitingMs + step.timing.thinkingMs + step.timing.respondingMs + step.timing.toolMs
    }
    const turns = report.turns.filter(turn => inRange(turn.start))
    const turnCount = report.turns.length ? turns.length : (steps > 0 ? Math.min(steps, report.stats.turns) : 0)
    const active = turns.reduce((sum, turn) => sum + Math.max(0, turn.end - turn.start), 0)
    timing.activeMs += Math.max(active, busy)
    if (steps === 0) continue
    totals.turns += turnCount
    totals.steps += steps
    if (priced) totals.pricedSessions += 1
    const session: InsightsSession = {
      id: source.id,
      kind: source.kind,
      title: report.title,
      updatedAt: report.updatedAt,
      window: report.window,
      current: report.current,
      turns: turnCount,
      steps,
      tokens,
      days: [...days].sort(),
    }
    if (source.projectId) session.projectId = source.projectId
    if (source.threadId) session.threadId = source.threadId
    if (report.model) session.model = report.model
    if (report.lastMessage) session.lastMessage = report.lastMessage
    const cost = costList(sessionCosts)
    if (cost) session.cost = cost
    sessions.push(session)
  }
  timing.otherMs = Math.max(0, timing.activeMs - timing.waitingMs - timing.thinkingMs - timing.respondingMs - timing.toolMs)
  if (cacheBase > 0) totals.cacheHitRate = totals.cachedTokens / cacheBase
  const cost = costList(costs)
  if (cost) totals.cost = cost
  for (const [index, day] of week.entries()) {
    const dayCost = costList(weekCosts[index]!)
    if (dayCost) day.cost = dayCost
  }
  const result: ContextInsights = {
    range,
    generatedAt: now,
    sessionCount: sources.length,
    activeSessions: sessions.length,
    totals,
    billed: { composition: roundComposition(billed), output },
    timing,
    week,
    activity,
    sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
  }
  if (from !== undefined) result.from = from
  return result
}
