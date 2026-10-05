import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/hooks'
import { formatTokens } from '../lib/timeline'
import type { UsageTotals, WorkspaceUsage } from '../lib/types'
import { formatCost, formatRate } from '../lib/usage'

/**
 * Token use and estimated spend for the current workspace: today, the last
 * seven days and all time, then the same split by model. Costs come from
 * the prices set on each model; a model without prices shows no cost.
 */
export function UsageSummary({ workspace }: { workspace: string | undefined }) {
  const [usage, setUsage] = useState<WorkspaceUsage | undefined>()
  const [error, setError] = useState<string>()
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
  return (
    <div className="usage-summary">
      <table className="usage-table">
        <thead>
          <tr><th scope="col" /><th scope="col">Input</th><th scope="col">Cached</th><th scope="col">Output</th><th scope="col">Cost</th></tr>
        </thead>
        <tbody>
          <Row label="Today" totals={usage.today} />
          <Row label="Last 7 days" totals={usage.week} />
          <Row label="All time" totals={usage.total} />
        </tbody>
      </table>
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
