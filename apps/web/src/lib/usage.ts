import type { UsageResponse, UsageTotals } from './types'

const SYMBOL: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', JPY: '¥' }

/** `$0.42`, `¥1.30`, or `0.42 CHF`; several currencies join with ` + `. */
export function formatCost(cost: UsageTotals['cost']): string | undefined {
  if (!cost?.length) return undefined
  return cost.map(({ amount, currency }) => {
    const digits = amount !== 0 && amount < 0.01 ? 4 : 2
    const value = amount.toFixed(digits)
    const symbol = SYMBOL[currency]
    return symbol ? `${symbol}${value}` : `${value} ${currency}`
  }).join(' + ')
}

export function formatRate(rate: number | undefined): string | undefined {
  return rate === undefined ? undefined : `${Math.round(rate * 100)}%`
}

export function localUsageDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Calendar arithmetic uses setDate so DST days still occupy one cell. */
export function usageCalendar(responses: readonly UsageResponse[], now = Date.now()) {
  const grouped = new Map<string, UsageResponse[]>()
  for (const response of responses) {
    const date = localUsageDate(response.timestamp)
    const entries = grouped.get(date) ?? []
    entries.push(response)
    grouped.set(date, entries)
  }
  const days = Array.from({ length: 371 }, (_, index) => {
    const at = new Date(now)
    at.setDate(at.getDate() - 370 + index)
    const date = localUsageDate(at.getTime())
    const entries = grouped.get(date) ?? []
    return { date, weekday: at.getDay(), responses: entries, tokens: entries.reduce((sum, entry) => sum + entry.promptTokens + entry.completionTokens, 0) }
  })
  const max = Math.max(1, ...days.map(day => day.tokens))
  return days.map(day => ({ ...day, level: day.tokens === 0 ? 0 : Math.min(4, Math.ceil(day.tokens / max * 4)) }))
}
