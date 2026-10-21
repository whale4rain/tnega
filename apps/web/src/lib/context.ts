import type { ContextCategory, ContextComposition, ContextStep, ContextTiming, InsightsRange, InsightsSession } from './types'

/**
 * Context display: the categories a prompt is made of, in the order the model
 * reads them, with the series colour each one is drawn in (tokens.css
 * `--series-*`). Everything here is pure so the views only lay it out.
 */
export const CONTEXT_SERIES: ReadonlyArray<{ key: ContextCategory; label: string; hint: string }> = [
  { key: 'system', label: 'System prompt', hint: 'The persona, instructions and skill index every request starts with' },
  { key: 'tools', label: 'Tool schemas', hint: 'Names, descriptions and parameters of the tools the model may call' },
  { key: 'user', label: 'User messages', hint: 'What you wrote' },
  { key: 'injected', label: 'Injected context', hint: 'Later system notes, plugin nudges and compaction summaries' },
  { key: 'assistant', label: 'Assistant replies', hint: 'The model’s own answers and tool requests' },
  { key: 'results', label: 'Tool results', hint: 'What the tools returned' },
]

export const OUTPUT_SERIES = { key: 'output', label: 'Output', hint: 'Tokens the model wrote, reasoning included' } as const

export function seriesColor(key: string): string {
  return `var(--series-${key})`
}

export const TIMING_SERIES: ReadonlyArray<{ key: keyof Pick<ContextTiming, 'waitingMs' | 'thinkingMs' | 'respondingMs' | 'toolMs' | 'otherMs'>; label: string; color: string; hint: string }> = [
  { key: 'waitingMs', label: 'Waiting', color: seriesColor('system'), hint: 'From sending a request to its first token' },
  { key: 'thinkingMs', label: 'Thinking', color: seriesColor('injected'), hint: 'Streaming reasoning' },
  { key: 'respondingMs', label: 'Responding', color: seriesColor('output'), hint: 'Streaming the answer and tool arguments' },
  { key: 'toolMs', label: 'Tool runs', color: seriesColor('results'), hint: 'Tools running' },
  { key: 'otherMs', label: 'Other', color: seriesColor('other'), hint: 'Approvals, waiting on you and harness work between steps' },
]

export const RANGES: ReadonlyArray<readonly [InsightsRange, string]> = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['all', 'All'],
]

export function total(composition: ContextComposition): number {
  return CONTEXT_SERIES.reduce((sum, { key }) => sum + composition[key], 0)
}

/** `12%`, `<1%` for a sliver, `0%` for nothing; one decimal when asked. */
export function share(part: number, whole: number, digits = 0): string {
  if (whole <= 0 || part <= 0) return '0%'
  const value = part / whole * 100
  const floor = digits ? 0.1 : 1
  if (value < floor) return `<${floor}%`
  return `${value.toFixed(digits)}%`
}

/** One bar of the trend chart: a request, or the last request of a turn. */
export interface TrendBar {
  key: string
  label: string
  turn: number
  step?: number
  ts: number
  estimate: ContextComposition
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  compacted: boolean
}

/**
 * Bars for the trend chart. By step, one bar per request. By turn, the
 * context as the turn's last request saw it, so the bar shows where the turn
 * left the window; a compaction anywhere in the turn marks it.
 */
export function trendBars(steps: readonly ContextStep[], by: 'step' | 'turn'): TrendBar[] {
  const bar = (step: ContextStep, compacted: boolean, turnOnly: boolean): TrendBar => ({
    key: turnOnly ? `t${step.turn}` : `t${step.turn}s${step.step}`,
    label: turnOnly ? `Turn ${step.turn}` : `Turn ${step.turn} · step ${step.step}`,
    turn: step.turn,
    ...(turnOnly ? {} : { step: step.step }),
    ts: step.ts,
    estimate: step.estimate,
    promptTokens: step.promptTokens,
    completionTokens: step.completionTokens,
    ...(step.cachedTokens !== undefined ? { cachedTokens: step.cachedTokens } : {}),
    compacted,
  })
  if (by === 'step') return steps.map(step => bar(step, step.compacted === true, false))
  const turns = new Map<number, { last: ContextStep; compacted: boolean }>()
  for (const step of steps) {
    const entry = turns.get(step.turn)
    turns.set(step.turn, { last: step, compacted: (entry?.compacted ?? false) || step.compacted === true })
  }
  return [...turns.values()].map(({ last, compacted }) => bar(last, compacted, true))
}

/** A round axis maximum (1, 2, 2.5 or 5 × 10ⁿ) at or above `value`. */
export function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}

/** Scale an estimate to the provider's prompt count, so a bar's height is what was sent. */
export function scaled(estimate: ContextComposition, tokens: number): ContextComposition {
  const sum = total(estimate)
  const factor = sum > 0 ? tokens / sum : 0
  const result = { ...estimate }
  for (const { key } of CONTEXT_SERIES) result[key] = estimate[key] * factor
  return result
}

export type SessionSort = 'recent' | 'tokens' | 'context'

/** Session cards on the insights page: filtered by kind, day and text, then sorted. */
export function filterSessions(
  sessions: readonly InsightsSession[],
  { kind, day, query, sort }: { kind: 'all' | 'session' | 'thread'; day?: string | undefined; query: string; sort: SessionSort },
): InsightsSession[] {
  const needle = query.trim().toLowerCase()
  const list = sessions.filter(session =>
    (kind === 'all' || session.kind === kind)
    && (!day || session.days.includes(day))
    && (!needle || session.title.toLowerCase().includes(needle) || (session.lastMessage ?? '').toLowerCase().includes(needle)))
  const key = (session: InsightsSession) => sort === 'tokens' ? session.tokens : sort === 'context' ? session.current.tokens : session.updatedAt
  return list.sort((a, b) => key(b) - key(a))
}

/** `YYYY-MM-DD` read as a local date. */
export function parseLocalDate(date: string): Date {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}
