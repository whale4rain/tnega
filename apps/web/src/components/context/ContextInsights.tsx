import { Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { CONTEXT_SERIES, RANGES, filterSessions, parseLocalDate, scaled, seriesColor, share, type SessionSort } from '../../lib/context'
import { errorText, relativeTime, useStoredState } from '../../lib/hooks'
import { formatDuration, formatTokens } from '../../lib/timeline'
import type { ContextInsights as Insights, InsightsDay, InsightsRange, InsightsSession, WorkspaceUsage } from '../../lib/types'
import { formatCost, formatRate } from '../../lib/usage'
import { Ring, Section, Stat, Toggle } from './charts'
import { TimingStats, TokenStats } from './ContextParts'

const RANGE_IDS = RANGES.map(([id]) => id)

/**
 * Settings → Context insights: how the open workspace spends its context.
 * Figures for the picked range, the last week, twelve weeks of activity, the
 * token and time split, and one card per session that opens it.
 */
export function ContextInsights({ workspace, onOpenSession }: {
  workspace: string | undefined
  onOpenSession?: ((session: InsightsSession) => void) | undefined
}) {
  const [range, setRange] = useStoredState<InsightsRange>('tnega.insightsRange', '30d', RANGE_IDS)
  const [insights, setInsights] = useState<Insights | undefined>()
  const [usage, setUsage] = useState<WorkspaceUsage | undefined>()
  const [error, setError] = useState<string>()
  const [day, setDay] = useState<string>()
  useEffect(() => {
    if (!workspace) return
    const scope = new AbortController()
    setError(undefined)
    api.contextInsights(workspace, range, scope.signal).then(setInsights, reason => { if (!scope.signal.aborted) setError(errorText(reason)) })
    return () => scope.abort()
  }, [workspace, range])
  useEffect(() => {
    if (!workspace) return
    const scope = new AbortController()
    api.usage(workspace, scope.signal).then(setUsage, () => undefined)
    return () => scope.abort()
  }, [workspace])

  if (!workspace) return <p className="muted small">Open a workspace to see its context insights.</p>
  return (
    <div className="ctx-stack ctx-insights">
      <div className="ctx-insights-bar">
        <Toggle label="Range" value={range} options={RANGES} onChange={value => { setInsights(undefined); setRange(value) }} />
      </div>
      {error && <div role="alert" className="notice notice-error">{error}</div>}
      {!insights && !error && <div className="skeleton"><div className="skeleton-line w90" /><div className="skeleton-line w60" /></div>}
      {insights && <InsightsBody insights={insights} usage={usage} day={day} onDay={setDay} onOpenSession={onOpenSession} />}
    </div>
  )
}

function InsightsBody({ insights, usage, day, onDay, onOpenSession }: {
  insights: Insights
  usage: WorkspaceUsage | undefined
  day: string | undefined
  onDay: (day: string | undefined) => void
  onOpenSession: ((session: InsightsSession) => void) | undefined
}) {
  const { totals, timing } = insights
  const cost = formatCost(totals.cost)
  const unpriced = usage?.byModel.filter(model => !model.priced).map(model => model.name) ?? []
  return (
    <>
      <Section title="Overview">
        <div className="ctx-stats">
          <Stat label="Active sessions" value={insights.activeSessions.toLocaleString()} note={`of ${insights.sessionCount.toLocaleString()}`} />
          <Stat label="Tokens" value={formatTokens(totals.promptTokens + totals.completionTokens)} note={`${totals.turns.toLocaleString()} turns`} />
          <Stat label="Cost" value={cost ?? '—'} note={cost ? `${totals.pricedSessions} of ${insights.activeSessions} sessions priced` : 'No price set'} hint="From the prices set on each model under Models" />
          <Stat label="Cache hit" value={formatRate(totals.cacheHitRate) ?? '—'} note={`${formatTokens(totals.cachedTokens)} cached`} hint="Share of input the provider served from its prompt cache, which is billed cheaper" />
          <Stat label="Tool calls" value={totals.toolCalls.toLocaleString()} note={`${formatDuration(timing.toolMs)} running`} />
          <Stat label="Active time" value={formatDuration(timing.activeMs)} note={`${totals.steps.toLocaleString()} model requests`} />
        </div>
      </Section>
      <div className="ctx-row">
        <Week days={insights.week} />
        <Activity days={insights.activity} selected={day} onSelect={onDay} />
      </div>
      <TokenStats billed={insights.billed} cacheHitRate={totals.cacheHitRate} />
      <TimingStats timing={timing} />
      <Sessions sessions={insights.sessions} day={day} onClearDay={() => onDay(undefined)} onOpen={onOpenSession} />
      {usage && usage.byModel.length > 0 && (
        <Section title="By model" aside={<span className="muted small">All time</span>}>
          <table className="ctx-models">
            <thead><tr><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cache hit</th><th scope="col">Cost</th></tr></thead>
            <tbody>
              {usage.byModel.map(model => (
                <tr key={model.modelId}>
                  <th scope="row">{model.name}</th>
                  <td>{formatTokens(model.promptTokens)}</td>
                  <td>{formatTokens(model.completionTokens)}</td>
                  <td>{formatRate(model.cacheHitRate) ?? '—'}</td>
                  <td>{formatCost(model.cost) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {unpriced.length > 0 && <p className="muted small ctx-footnote">No prices set for {unpriced.join(', ')}; add them under Models to estimate cost.</p>}
        </Section>
      )}
    </>
  )
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const LONG_DATE = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' })

/** Tokens per day for the last seven days, with the day's cost underneath. */
function Week({ days }: { days: readonly InsightsDay[] }) {
  const max = Math.max(1, ...days.map(item => item.tokens))
  return (
    <Section title="Last 7 days">
      <div className="ctx-week" role="list">
        {days.map(item => {
          const date = parseLocalDate(item.date)
          const cost = formatCost(item.cost)
          return (
            <div key={item.date} className="ctx-week-day" role="listitem" aria-label={`${LONG_DATE.format(date)}: ${item.tokens.toLocaleString()} tokens${cost ? `, ${cost}` : ''}`} title={`${LONG_DATE.format(date)} · ${item.tokens.toLocaleString()} tokens · ${item.steps} requests${cost ? ` · ${cost}` : ''}`}>
              <span className="ctx-week-value">{item.tokens ? formatTokens(item.tokens) : ''}</span>
              <span className="ctx-week-track"><span className="ctx-week-fill" style={{ height: `${item.tokens / max * 100}%` }} /></span>
              <span className="ctx-week-label">{WEEKDAY.format(date)}</span>
              <span className="ctx-week-cost">{cost ?? ''}</span>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

/** Twelve weeks of daily tokens. A day filters the session cards. */
function Activity({ days, selected, onSelect }: { days: readonly InsightsDay[]; selected: string | undefined; onSelect: (day: string | undefined) => void }) {
  const max = Math.max(1, ...days.map(item => item.tokens))
  const first = days[0] ? parseLocalDate(days[0].date).getDay() : 0
  return (
    <Section title="Activity" aside={<span className="muted small">12 weeks</span>}>
      <div className="ctx-heatmap" role="group" aria-label="Daily tokens, last twelve weeks">
        {days.map((item, index) => {
          const level = item.tokens === 0 ? 0 : Math.min(4, Math.ceil(item.tokens / max * 4))
          const label = `${LONG_DATE.format(parseLocalDate(item.date))}: ${item.tokens.toLocaleString()} tokens`
          return (
            <button
              key={item.date}
              type="button"
              className={`usage-day usage-level-${level}`}
              aria-label={label}
              title={label}
              aria-pressed={selected === item.date}
              disabled={item.tokens === 0}
              style={index === 0 ? { gridRowStart: first + 1 } : undefined}
              onClick={() => onSelect(selected === item.date ? undefined : item.date)}
            />
          )
        })}
      </div>
      <div className="usage-legend"><span className="muted small">Less</span>{[0, 1, 2, 3, 4].map(level => <span key={level} className={`usage-day usage-level-${level}`} aria-hidden />)}<span className="muted small">More</span></div>
    </Section>
  )
}

const SORTS: ReadonlyArray<readonly [SessionSort, string]> = [['recent', 'Recent'], ['tokens', 'Tokens'], ['context', 'Context']]

function Sessions({ sessions, day, onClearDay, onOpen }: {
  sessions: readonly InsightsSession[]
  day: string | undefined
  onClearDay: () => void
  onOpen: ((session: InsightsSession) => void) | undefined
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SessionSort>('recent')
  const [kind, setKind] = useState<'all' | 'session' | 'thread'>('all')
  const threads = sessions.filter(session => session.kind === 'thread').length
  const list = filterSessions(sessions, { kind, day, query, sort })
  return (
    <Section title="Sessions" aside={<Toggle label="Sort sessions by" value={sort} options={SORTS} onChange={setSort} />}>
      <div className="ctx-session-filters">
        <label className="ctx-search">
          <Search size={14} aria-hidden />
          <input type="search" value={query} placeholder="Search titles and last messages" aria-label="Search sessions" onChange={event => setQuery(event.target.value)} />
        </label>
        {threads > 0 && (
          <Toggle label="Show" value={kind} options={[['all', `All ${sessions.length}`], ['session', `Sessions ${sessions.length - threads}`], ['thread', `Project threads ${threads}`]]} onChange={setKind} />
        )}
        {day && (
          <button type="button" className="chip" onClick={onClearDay} aria-label={`Clear the day filter, ${LONG_DATE.format(parseLocalDate(day))}`}>
            {LONG_DATE.format(parseLocalDate(day))}<X size={12} aria-hidden />
          </button>
        )}
      </div>
      {list.length === 0
        ? <p className="muted small">{sessions.length === 0 ? 'No session used the model in this range.' : 'No session matches.'}</p>
        : <div className="ctx-cards">{list.map(session => <SessionCard key={`${session.kind}:${session.id}`} session={session} onOpen={onOpen} />)}</div>}
    </Section>
  )
}

function SessionCard({ session, onOpen }: { session: InsightsSession; onOpen: ((session: InsightsSession) => void) | undefined }) {
  const parts = scaled(session.current.estimate, session.current.tokens)
  const segments = CONTEXT_SERIES.map(({ key, label }) => ({ key, label, value: parts[key], color: seriesColor(key) }))
  const cost = formatCost(session.cost)
  const open = onOpen ? () => onOpen(session) : undefined
  return (
    <button type="button" className="ctx-card" onClick={open} disabled={!open} aria-label={`Open ${session.title}`}>
      <span className="ctx-card-head">
        <span className="ctx-card-title">{session.title}</span>
        <span className="ctx-card-time" title={new Date(session.updatedAt).toLocaleString()}>{relativeTime(session.updatedAt)}</span>
      </span>
      {session.kind === 'thread' && <span className="ctx-card-kind">Project thread</span>}
      <span className="ctx-card-body">
        <Ring segments={segments} size={56} label={formatTokens(session.current.tokens)} title={`Context now ${session.current.tokens.toLocaleString()} tokens`} />
        <span className="ctx-card-figures">
          <span><span className="muted">Window</span> {share(session.current.tokens, session.window)}</span>
          <span><span className="muted">Turns</span> {session.turns} · {session.steps} steps</span>
          <span><span className="muted">Tokens</span> {formatTokens(session.tokens)}</span>
          {cost && <span><span className="muted">Cost</span> {cost}</span>}
        </span>
      </span>
      {session.lastMessage && <span className="ctx-card-last">{session.lastMessage}</span>}
    </button>
  )
}
