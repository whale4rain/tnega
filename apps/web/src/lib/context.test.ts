import { describe, expect, it } from 'vitest'
import { filterSessions, niceMax, scaled, share, trendBars } from './context'
import type { ContextStep, InsightsSession } from './types'

const estimate = { system: 10, tools: 10, user: 10, injected: 0, assistant: 20, results: 50 }
const step = (turn: number, index: number, prompt: number, compacted = false): ContextStep => ({
  turn, step: index, ts: turn * 1000 + index, modelId: 'flash', estimate, promptTokens: prompt, completionTokens: 5, toolCalls: 0,
  timing: { waitingMs: 0, thinkingMs: 0, respondingMs: 0, toolMs: 0, toolRuns: 0 },
  ...(compacted ? { compacted } : {}),
})

describe('context display helpers', () => {
  it('draws one bar per request, or the last request of each turn', () => {
    const steps = [step(1, 1, 100), step(1, 2, 200), step(2, 1, 50, true), step(2, 2, 80)]
    expect(trendBars(steps, 'step').map(bar => bar.promptTokens)).toEqual([100, 200, 50, 80])
    const turns = trendBars(steps, 'turn')
    expect(turns.map(bar => [bar.label, bar.promptTokens, bar.compacted])).toEqual([['Turn 1', 200, false], ['Turn 2', 80, true]])
  })

  it('scales an estimate to the tokens actually sent', () => {
    const parts = scaled(estimate, 200)
    expect(parts.results).toBe(100)
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(200)
  })

  it('writes shares without rounding a sliver to nothing', () => {
    expect(share(1, 1000)).toBe('<1%')
    expect(share(0, 1000)).toBe('0%')
    expect(share(125, 1000, 1)).toBe('12.5%')
  })

  it('rounds the axis up to a readable figure', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(130)).toBe(200)
    expect(niceMax(2300)).toBe(2500)
    expect(niceMax(51_000)).toBe(100_000)
  })

  it('filters session cards by kind, day and text, then sorts them', () => {
    const card = (id: string, kind: 'session' | 'thread', tokens: number, updatedAt: number, days: string[]): InsightsSession => ({
      id, kind, title: `Title ${id}`, updatedAt, window: 1000, turns: 1, steps: 1, tokens, days,
      current: { estimate, tokens: tokens / 10, source: 'estimate' },
    })
    const sessions = [card('a', 'session', 10, 3, ['2026-10-20']), card('b', 'thread', 30, 1, ['2026-10-21']), card('c', 'session', 20, 2, ['2026-10-21'])]
    expect(filterSessions(sessions, { kind: 'all', query: '', sort: 'recent' }).map(item => item.id)).toEqual(['a', 'c', 'b'])
    expect(filterSessions(sessions, { kind: 'all', query: '', sort: 'tokens' }).map(item => item.id)).toEqual(['b', 'c', 'a'])
    expect(filterSessions(sessions, { kind: 'session', day: '2026-10-21', query: '', sort: 'recent' }).map(item => item.id)).toEqual(['c'])
    expect(filterSessions(sessions, { kind: 'all', query: 'title b', sort: 'recent' }).map(item => item.id)).toEqual(['b'])
  })
})
