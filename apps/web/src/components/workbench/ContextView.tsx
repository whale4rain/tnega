import { Gauge, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { errorText } from '../../lib/hooks'
import { formatTokens } from '../../lib/timeline'
import { formatBytes } from '../../lib/project-model'
import type { ContextToolUse, SessionContextReport } from '../../lib/types'
import { formatCost, formatRate } from '../../lib/usage'
import { Section, Stat } from '../context/charts'
import { ContextTrend, CurrentContext, TimingStats, TokenStats } from '../context/ContextParts'

/** How often the tab re-reads the session while it is on screen. */
export const CONTEXT_REFRESH_MS = 5_000

/**
 * The Workbench's Context tool: what the open session's context is made of
 * and how it got there. Stats, the billed-token split, where time went, the
 * window right now, and one bar per request. Refreshes while visible.
 */
export function ContextView({ workspace, sessionId, visible }: { workspace: string; sessionId: string | undefined; visible: boolean }) {
  const [report, setReport] = useState<SessionContextReport | undefined>()
  const [error, setError] = useState<string>()
  const [loadedFor, setLoadedFor] = useState<string>()

  const load = useCallback((signal?: AbortSignal) => {
    if (!sessionId) return
    api.context(workspace, sessionId, signal).then(next => {
      setReport(next)
      setLoadedFor(sessionId)
      setError(undefined)
    }, reason => { if (!signal?.aborted) setError(errorText(reason)) })
  }, [workspace, sessionId])

  useEffect(() => {
    if (!visible || !sessionId) return
    const scope = new AbortController()
    load(scope.signal)
    const timer = window.setInterval(() => load(scope.signal), CONTEXT_REFRESH_MS)
    return () => { scope.abort(); window.clearInterval(timer) }
  }, [visible, sessionId, load])

  if (!sessionId) {
    return (
      <div className="wb-view" aria-label="Context">
        <div className="wb-toolbar"><span className="wb-toolbar-title">Context</span></div>
        <div className="wb-card">
          <div className="wb-empty">
            <Gauge size={20} aria-hidden />
            <p>Open a session to see what its context is made of: stats, the token split, timing and how the window grew.</p>
          </div>
        </div>
      </div>
    )
  }
  const current = loadedFor === sessionId ? report : undefined
  return (
    <div className="wb-view" aria-label="Context">
      <div className="wb-toolbar">
        <span className="wb-toolbar-title">{current?.title ?? 'Context'}</span>
        <button type="button" className="icon-button small" onClick={() => load()} aria-label="Refresh context" title="Refresh"><RefreshCw size={14} /></button>
      </div>
      <div className="wb-card wb-scroll ctx-view">
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {!current && !error && <div className="skeleton"><div className="skeleton-line w90" /><div className="skeleton-line w60" /></div>}
        {current && <ContextReport report={current} />}
      </div>
    </div>
  )
}

export function ContextReport({ report }: { report: SessionContextReport }) {
  const { stats } = report
  const cost = formatCost(stats.cost)
  return (
    <div className="ctx-stack">
      <Section title="Context stats">
        <div className="ctx-stats">
          <Stat label="Turns" value={stats.turns.toLocaleString()} note={`${stats.userInputs.toLocaleString()} from you`} />
          <Stat label="Steps" value={stats.steps.toLocaleString()} note="model requests" />
          <Stat label="Tool calls" value={stats.toolCalls.toLocaleString()} note={stats.toolErrors ? `${stats.toolErrors} failed` : 'none failed'} />
          <Stat label="Tokens" value={formatTokens(stats.promptTokens + stats.completionTokens)} note={`${formatTokens(stats.completionTokens)} output`} />
          <Stat label="Cache hit" value={formatRate(stats.cacheHitRate) ?? '—'} note={`${formatTokens(stats.cachedTokens)} cached`} hint="Share of input the provider served from its prompt cache, which is billed cheaper" />
          <Stat
            label="Cost"
            value={cost ?? '—'}
            note={!cost ? 'No price set' : stats.pricedSteps < stats.steps ? `${stats.pricedSteps} of ${stats.steps} steps priced` : 'estimated'}
            hint="From the prices set on each model under Settings → Models"
          />
        </div>
        {stats.compactions > 0 && <p className="muted small ctx-footnote">Compacted {stats.compactions === 1 ? 'once' : `${stats.compactions} times`}.</p>}
      </Section>
      <CurrentContext current={report.current} window={report.window} compactAt={report.compactAt} model={report.model} />
      <ContextTrend steps={report.steps} window={report.window} />
      <TokenStats billed={report.billed} cacheHitRate={stats.cacheHitRate} />
      <TimingStats timing={report.timing} />
      {report.tools.length > 0 && <ToolStats tools={report.tools} />}
    </div>
  )
}

/** What each tool cost: its calls and images, and the requests that read its results. */
function ToolStats({ tools }: { tools: readonly ContextToolUse[] }) {
  return (
    <Section title="By tool">
      <div className="ctx-table-scroll">
        <table className="ctx-models">
          <thead><tr><th scope="col">Tool</th><th scope="col">Calls</th><th scope="col">Images</th><th scope="col">Input</th><th scope="col">Cost</th></tr></thead>
          <tbody>
            {tools.map(tool => (
              <tr key={tool.name}>
                <th scope="row" className="mono" title={tool.name}>{tool.name}</th>
                <td>{tool.calls.toLocaleString()}{tool.failed ? <span className="muted"> · {tool.failed} failed</span> : null}</td>
                <td>{tool.images ? `${tool.images.toLocaleString()} · ${formatBytes(tool.imageBytes)}` : '—'}</td>
                <td title={`${tool.cachedTokens.toLocaleString()} cached, ${tool.completionTokens.toLocaleString()} output`}>{formatTokens(tool.promptTokens)}</td>
                <td>{formatCost(tool.cost) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small ctx-footnote">Input and cost are those of the requests that read each tool’s results, split evenly when one request read several.</p>
    </Section>
  )
}
