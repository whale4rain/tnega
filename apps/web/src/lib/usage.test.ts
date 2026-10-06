import { expect, it } from 'vitest'
import { formatCost, formatRate, usageCalendar, dailyUsageTotals } from './usage'

it('formats spend in the route currency, keeping small amounts readable', () => {
  expect(formatCost([{ amount: 1.234, currency: 'USD' }])).toBe('$1.23')
  expect(formatCost([{ amount: 0.0042, currency: 'CNY' }])).toBe('¥0.0042')
  expect(formatCost([{ amount: 2, currency: 'USD' }, { amount: 3, currency: 'CHF' }])).toBe('$2.00 + 3.00 CHF')
  expect(formatCost(undefined)).toBeUndefined()
  expect(formatRate(0.876)).toBe('88%')
})

it('uses local calendar dates, fills empty days and keeps response details', () => {
  const at = new Date(2026, 9, 6, 23, 30).getTime()
  const response = { sessionId: 's', sessionTitle: 'Test', timestamp: at, modelId: 'm', responses: 1, promptTokens: 10, completionTokens: 5, cachedTokens: 4, reasoningTokens: 0 }
  const days = usageCalendar([response], at)
  expect(days).toHaveLength(371)
  expect(days.at(-1)).toMatchObject({ date: '2026-10-06', tokens: 15, level: 4, responses: [response] })
  expect(days[0]?.tokens).toBe(0)
  expect(days[0]?.level).toBe(0)
})

it('summarizes a selected day across models and sessions, including currencies', () => {
  const base = { sessionId: 's', sessionTitle: 'Test', timestamp: 1, modelId: 'm', responses: 1, promptTokens: 10, completionTokens: 5, cachedTokens: 4, reasoningTokens: 2 }
  expect(dailyUsageTotals([
    { ...base, cost: [{ amount: 0.2, currency: 'USD' }] },
    { ...base, modelId: 'other', sessionId: 'other', promptTokens: 20, cost: [{ amount: 0.3, currency: 'USD' }, { amount: 1, currency: 'CNY' }] },
  ])).toMatchObject({ responses: 2, promptTokens: 30, completionTokens: 10, cachedTokens: 8, reasoningTokens: 4, cost: [{ amount: 0.5, currency: 'USD' }, { amount: 1, currency: 'CNY' }] })
})
