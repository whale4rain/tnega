import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/hooks'
import { formatTokens } from '../lib/timeline'
import type { UsageTotals, WorkspaceUsage } from '../lib/types'
import { formatCost, formatRate, usageCalendar } from '../lib/usage'

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
  return (
    <div className="usage-summary">
      <div className="usage-totals">
        {[['Today', usage.today], ['Last 7 days', usage.week], ['All time', usage.total]].map(([label, value]) => {
          if (typeof value === 'string' || !value) return null
          return <div key={String(label)}><span className="muted small">{String(label)}</span><strong>{formatTokens(value.promptTokens + value.completionTokens)} tokens</strong><span className="muted small">{formatCost(value.cost) ?? 'Cost unavailable'}</span></div>
        })}
      </div>
      <p className="muted small">Daily usage · {days[0]!.date} – {days.at(-1)!.date} · local time</p>
      <div className="usage-calendar-scroll">
        <div className="usage-calendar" role="group" aria-label="Daily token usage calendar">
          {days.map((day, index) => {
            const label = `${day.date}: ${day.tokens.toLocaleString()} tokens, ${day.responses.length} responses`
            return <button key={day.date} type="button" className={`usage-day usage-level-${day.level}`} aria-label={label} title={label} aria-pressed={chosen.date === day.date} style={index === 0 ? { gridRowStart: day.weekday + 1 } : undefined} onClick={() => setSelected(day.date)} />
          })}
        </div>
      </div>
      <div className="usage-legend"><span>Less</span>{[0, 1, 2, 3, 4].map(level => <span key={level} className={`usage-day usage-level-${level}`} aria-label={`Intensity ${level} of 4`} />)}<span>More</span><span className="muted small">Input + output tokens; cache is included in input.</span></div>
      <details open className="usage-details">
        <summary>{chosen.date} · {chosen.tokens.toLocaleString()} tokens · {chosen.responses.length} responses</summary>
        {chosen.responses.length === 0 ? <p className="muted small">No usage on this day.</p> : <div className="usage-detail-scroll"><table className="usage-table"><thead><tr><th>Time / Session</th><th>Model</th><th>Input</th><th>Output</th><th>Cached</th><th>Reasoning</th></tr></thead><tbody>{chosen.responses.map((response, index) => <tr key={`${response.sessionId}-${response.timestamp}-${index}`}><th scope="row" title={response.sessionId}>{new Date(response.timestamp).toLocaleTimeString()}<br />{response.sessionTitle}</th><td>{response.modelId}</td><td>{formatTokens(response.promptTokens)}</td><td>{formatTokens(response.completionTokens)}</td><td>{formatTokens(response.cachedTokens)}</td><td>{formatTokens(response.reasoningTokens)}</td></tr>)}</tbody></table></div>}
      </details>
      {usage.byModel.length > 0 && (
        <table className="usage-table">
          <thead>
            <tr><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Cached</th><th scope="col">Output</th><th scope="col">Cost</th></tr>
          </thead>
          <tbody>
            {usage.byModel.map(model => <Row key={model.modelId} label={model.name} totals={model} />)}
          </tbody>
        </table>
      )}
      <p className="muted small">
        {usage.sessions} {usage.sessions === 1 ? 'session' : 'sessions'} in this workspace. Cached is the share of input the provider served from its prompt cache (KV cache), which is billed cheaper.
        {unpriced.length > 0 && ` No prices set for ${unpriced.join(', ')}; add them under Models to estimate cost.`}
      </p>
    </div>
  )
}

function Row({ label, totals }: { label: string; totals: UsageTotals }) {
  const rate = formatRate(totals.cacheHitRate)
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{formatTokens(totals.promptTokens)}</td>
      <td title={rate ? `${rate} of input served from cache` : 'No cache accounting reported'}>{rate ?? '—'}</td>
      <td>{formatTokens(totals.completionTokens)}</td>
      <td>{formatCost(totals.cost) ?? '—'}</td>
    </tr>
  )
}
