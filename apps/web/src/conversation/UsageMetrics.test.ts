// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { UsageMetrics, formatRate, formatTokens } from './UsageMetrics'
import type { SessionMetrics } from '../types'

afterEach(cleanup)

const context = { tokens: 12_340, limit: 128_000, ratio: 0.0964 }

function metrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    responses: 3,
    promptTokens: 5_000,
    completionTokens: 400,
    cachedTokens: 3_900,
    ...overrides,
  }
}

it('formats token counts and rates at a readable precision', () => {
  expect(formatTokens(0)).toBe('0')
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(1_240)).toBe('1.2k')
  expect(formatTokens(12_340)).toBe('12k')
  expect(formatTokens(2_500_000)).toBe('2.5M')
  expect(formatRate(4.25)).toBe('4.3')
  expect(formatRate(320.4)).toBe('320')
})

it('shows context, throughput and cache hit rate together', () => {
  render(createElement(UsageMetrics, {
    context,
    metrics: metrics({ cacheHitRate: 0.78, tokensPerSecond: 42.5, lastDurationMs: 9_400 }),
  }))

  expect(screen.getByText('12k / 128k · 10%')).toBeTruthy()
  expect(screen.getByText('42.5 tok/s')).toBeTruthy()
  expect(screen.getByText('78%')).toBeTruthy()
})

it('omits a measurement the provider never reported', () => {
  render(createElement(UsageMetrics, { context, metrics: metrics() }))

  expect(screen.getByText('12k / 128k · 10%')).toBeTruthy()
  // No throughput and no cache rate were reported, so neither is rendered —
  // least of all as a zero.
  expect(screen.queryByText('speed')).toBeNull()
  expect(screen.queryByText('cache')).toBeNull()
})

it('renders nothing before the session has measured anything', () => {
  const { container } = render(createElement(UsageMetrics, { context: null, metrics: null }))
  expect(container.querySelector('.usage-metrics')).toBeNull()
})
