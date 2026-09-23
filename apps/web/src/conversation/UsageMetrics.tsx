import type { ContextUsage, SessionMetrics } from '../types'

/** `12_340` → `12.3k`. Below a thousand the exact count is more useful than a rounded one. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** Throughput keeps a decimal where it carries information and drops it where it does not. */
export function formatRate(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1)
}

interface UsageMetricsProps {
  context: ContextUsage | null
  metrics?: SessionMetrics | null
}

/**
 * The measurements of the current session, under the composer.
 *
 * Every number is provider- or estimator-reported, so a measurement that never
 * arrived is left out rather than shown as a zero: an absent cache rate reads
 * as "the provider didn't say", never as "0% cached". When nothing at all is
 * known — a brand-new session — the strip renders nothing.
 */
export function UsageMetrics({ context, metrics }: UsageMetricsProps) {
  const items: Array<{ key: string; label: string; value: string; title: string }> = []
  if (context) {
    const percent = Math.round(context.ratio * 100)
    items.push({
      key: 'context',
      label: context.source === 'provider' ? 'context' : 'estimated context',
      value: `${Math.round(context.tokens).toLocaleString()} / ${Math.round(context.limit).toLocaleString()} · ${percent}%`,
      title: context.source === 'provider'
        ? `Provider-reported prompt size against the ${context.limit.toLocaleString()}-token window`
        : `Estimated message size because the provider did not report prompt tokens; window is ${context.limit.toLocaleString()} tokens`,
    })
  }
  if (metrics?.tokensPerSecond !== undefined) {
    const duration = metrics.lastDurationMs !== undefined
      ? ` over ${metrics.lastDurationMs}ms`
      : ''
    items.push({
      key: 'speed',
      label: 'speed',
      value: `${formatRate(metrics.tokensPerSecond)} tok/s`,
      title: `Output tokens per second of the last response${duration}`,
    })
  }
  if (context) {
    items.push({
      key: 'cache',
      label: 'cache hit rate',
      value: metrics?.cacheHitRate !== undefined
        ? `${Math.round(metrics.cacheHitRate * 100)}%`
        : '—',
      title: metrics?.cacheHitRate !== undefined
        ? `${metrics.cachedTokens.toLocaleString()} of ${metrics.promptTokens.toLocaleString()} prompt tokens were served from the provider cache`
        : 'The provider has not reported cache token usage for this session',
    })
  }
  if (!items.length) return null
  return (
    <div className="usage-metrics" role="status" aria-label="Session metrics">
      {items.map((item) => (
        <span key={item.key} className="usage-metric" title={item.title}>
          <span className="usage-metric-label">{item.label}</span>
          <span className="usage-metric-value">{item.value}</span>
        </span>
      ))}
    </div>
  )
}
