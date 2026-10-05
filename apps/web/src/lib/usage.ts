import type { UsageTotals } from './types'

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
