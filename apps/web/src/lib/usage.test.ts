import { expect, it } from 'vitest'
import { formatCost, formatRate } from './usage'

it('formats spend in the route currency, keeping small amounts readable', () => {
  expect(formatCost([{ amount: 1.234, currency: 'USD' }])).toBe('$1.23')
  expect(formatCost([{ amount: 0.0042, currency: 'CNY' }])).toBe('¥0.0042')
  expect(formatCost([{ amount: 2, currency: 'USD' }, { amount: 3, currency: 'CHF' }])).toBe('$2.00 + 3.00 CHF')
  expect(formatCost(undefined)).toBeUndefined()
  expect(formatRate(0.876)).toBe('88%')
})
