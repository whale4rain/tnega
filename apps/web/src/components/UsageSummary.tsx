import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/hooks'
import { formatTokens } from '../lib/timeline'
import type { UsageTotals, WorkspaceUsage } from '../lib/types'
import { dailyUsageTotals, formatCost, formatRate, usageCalendar } from '../lib/usage'

/**
 * Token use and estimated spend for the current workspace: today, the last
 * seven days and all time, then the same split by model. Costs come from
 * the prices set on each model; a model without prices shows no cost.
 */
export function UsageSummary({ workspace }: { workspace: string | undefined }) {
  const [usage, setUsage] = useState<WorkspaceUsage | undefined>()
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  useEffect(() => {
    if (!workspace) return
    const scope = new AbortController()
    setUsage(undefined)
    setError(undefined)
    api.usage(workspace, scope.signal).then(setUsage, reason => { if (!scope.signal.aborted) setError(errorText(reason)) })
    return () => scope.abort()
  }, [workspace])

  if (!workspace) return <p className="muted small">Open a workspace to see its usage.</p>
  if (error) return <div role="alert" className="notice notice-error">{error}</div>
  if (!usage) return <div className="skeleton-line w60" />
  const unpriced = usage.byModel.filter(model => !model.priced).map(model => model.name)
  const days = usageCalendar(usage.responses ?? [])
  const chosen = days.find(day => day.date === selected) ?? days.at(-1)!
  const daily = dailyUsageTotals(chosen.responses)
  const columns = Math.ceil((days.length + days[0]!.weekday) / 7)
  const spans = [{ label: 'Today', totals: usage.today }, { label: 'Last 7 days', totals: usage.week }, { label: 'All time', totals: usage.total }]
  return (
    <div className="usage-summary">
      <div className="usage-totals">
        {spans.map(({ label, totals }) => <div key={label}><span className="muted small">{label}</span><strong>{formatTokens(totals.promptTokens + totals.completionTokens)} tokens</strong><span className="muted small">{formatCost(totals.cost) ?? 'Cost unavailable'}</span></div>)}
      </div>
      <p className="muted small">Daily usage · {days[0]!.date} – {days.at(-1)!.date} · local time</p>
      <div className="usage-calendar-scroll">
        <div className="usage-calendar" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} role="group" aria-label="Daily token usage calendar">
          {days.map((day, index) => {
            const label = `${day.date}: ${day.tokens.toLocaleString()} tokens, ${day.responses.length} responses`
            return <button key={day.date} type="button" className={`usage-day usage-level-${day.level}`} aria-label={label} title={label} aria-pressed={chosen.date === day.date} style={index === 0 ? { gridRowStart: day.weekday + 1 } : undefined} onClick={() => setSelected(day.date)} />
          })}
        </div>
      </div>
      <div className="usage-legend"><span>Less</span>{[0, 1, 2, 3, 4].map(level => <span key={level} className={`usage-day usage-level-${level}`} aria-label={`Intensity ${level} of 4`} />)}<span>More</span><span className="muted small">Input + output tokens; cache is included in input.</span></div>
      <details open className="usage-details">
        <summary>{chosen.date} · {chosen.tokens.toLocaleString()} tokens · {chosen.responses.length} responses</summary>
        {chosen.responses.length === 0 ? <p className="muted small">No usage on this day.</p> : (
          <UsageNumbers totals={daily} />
        )}
      </details>
      {usage.byModel.length > 0 && (
        <div className="usage-models">
          {usage.byModel.map(model => <section key={model.modelId} className="usage-model"><h4>{model.name}</h4><UsageNumbers totals={model} cacheRate /></section>)}
        </div>
      )}
      <p className="muted small">
        {usage.sessions} {usage.sessions === 1 ? 'session' : 'sessions'} in this workspace. Cached is the share of input the provider served from its prompt cache (KV cache), which is billed cheaper.
        {unpriced.length > 0 && ` No prices set for ${unpriced.join(', ')}; add them under Models to estimate cost.`}
      </p>
    </div>
  )
}

function UsageNumbers({ totals, cacheRate = false }: { totals: UsageTotals; cacheRate?: boolean }) {
  const numbers = [
    ['Input', formatTokens(totals.promptTokens)],
    ['Output', formatTokens(totals.completionTokens)],
    ['Cached', formatTokens(totals.cachedTokens)],
    ['Reasoning', formatTokens(totals.reasoningTokens)],
    ['Responses', totals.responses.toLocaleString()],
    ['Cost', formatCost(totals.cost) ?? '—'],
    ...(cacheRate ? [['Cache hit', formatRate(totals.cacheHitRate) ?? '—']] : []),
  ]
  return <dl className="usage-numbers">{numbers.map(([label, value]) => <div key={label}><dt className="muted small">{label}</dt><dd>{value}</dd></div>)}</dl>
}