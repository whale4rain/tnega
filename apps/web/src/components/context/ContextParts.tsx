import { Scissors } from 'lucide-react'
import { useState } from 'react'
import { CONTEXT_SERIES, OUTPUT_SERIES, TIMING_SERIES, niceMax, scaled, seriesColor, share, total, trendBars, type TrendBar } from '../../lib/context'
import { formatDuration, formatTokens } from '../../lib/timeline'
import type { ContextComposition, ContextCurrent, ContextStep, ContextTiming } from '../../lib/types'
import { Legend, Ring, Section, StackedBar, Toggle } from './charts'

/** Billed tokens split by what the prompts held, plus what the model wrote. */
export function TokenStats({ billed, cacheHitRate, title = 'Token stats' }: {
  billed: { composition: ContextComposition; output: number }
  cacheHitRate?: number | undefined
  title?: string
}) {
  const sum = total(billed.composition) + billed.output
  const segments = [
    ...CONTEXT_SERIES.map(({ key, label }) => ({ key, label, value: billed.composition[key], color: seriesColor(key) })),
    { key: OUTPUT_SERIES.key, label: OUTPUT_SERIES.label, value: billed.output, color: seriesColor('output') },
  ]
  const hints = new Map<string, string>([...CONTEXT_SERIES.map(item => [item.key, item.hint] as const), [OUTPUT_SERIES.key, OUTPUT_SERIES.hint]])
  return (
    <Section title={title} aside={cacheHitRate !== undefined ? <span className="muted small">Cache hit {share(cacheHitRate, 1, 1)}</span> : undefined}>
      <div className="ctx-split">
        <Ring segments={segments} label={formatTokens(sum)} sublabel="tokens" title={`${sum.toLocaleString()} billed tokens by kind`} />
        <Legend items={segments.map(segment => ({
          key: segment.key,
          label: segment.label,
          color: segment.color,
          value: `${segment.key === 'output' ? '' : '≈'}${formatTokens(Math.round(segment.value))}`,
          share: share(segment.value, sum, 1),
          ...(hints.get(segment.key) ? { hint: hints.get(segment.key)! } : {}),
        }))} />
      </div>
      <p className="muted small ctx-footnote">Each request’s prompt is split by an estimate of what it held, scaled to the tokens the provider billed. Output includes reasoning.</p>
    </Section>
  )
}

/** Where active time went. */
export function TimingStats({ timing }: { timing: ContextTiming }) {
  const segments = TIMING_SERIES.map(({ key, label, color }) => ({ key, label, value: timing[key], color }))
  const notes: Record<string, string> = {
    waitingMs: `${timing.modelCalls.toLocaleString()} ${timing.modelCalls === 1 ? 'call' : 'calls'}`,
    toolMs: `${timing.toolRuns.toLocaleString()} ${timing.toolRuns === 1 ? 'run' : 'runs'}`,
  }
  return (
    <Section title="Timing">
      <div className="ctx-split">
        <Ring segments={segments} label={formatDuration(timing.activeMs)} sublabel="active" title={`${formatDuration(timing.activeMs)} of active time by activity`} />
        <Legend items={TIMING_SERIES.map(({ key, label, color, hint }) => ({
          key,
          label,
          color,
          value: notes[key] ? `${formatDuration(timing[key])} · ${notes[key]}` : formatDuration(timing[key]),
          share: share(timing[key], timing.activeMs, 1),
          hint,
        }))} />
      </div>
    </Section>
  )
}

/** The window right now: what fills it, and how far it is from auto-compaction. */
export function CurrentContext({ current, window, compactAt, model }: { current: ContextCurrent; window: number; compactAt: number; model?: string | undefined }) {
  const estimate = total(current.estimate)
  // The bar shows what was sent; the estimate only decides the split.
  const parts = scaled(current.estimate, current.tokens)
  const segments = CONTEXT_SERIES.map(({ key, label }) => ({ key, label, value: parts[key], color: seriesColor(key) }))
  return (
    <Section title="Current context" aside={model ? <span className="muted small mono">{model}</span> : undefined}>
      <div className="ctx-current-head">
        <span><strong className="ctx-big">{formatTokens(current.tokens)}</strong> <span className="muted">/ {formatTokens(window)} tokens</span></span>
        <span><strong className="ctx-big">{share(current.tokens, window, 1)}</strong> <span className="muted">of the window</span></span>
      </div>
      <StackedBar
        segments={segments}
        max={window}
        marker={{ at: compactAt, label: `Auto-compaction starts at ${Math.round(compactAt * 100)}%` }}
        title={`${current.tokens.toLocaleString()} of ${window.toLocaleString()} tokens used`}
      />
      <p className="muted small ctx-footnote">
        {current.source === 'provider' ? 'Size as the provider reported the last request' : 'Estimated size; no request has been sent since the last change'}
        {` · auto-compaction starts at ${Math.round(compactAt * 100)}%.`}
      </p>
      <Legend items={CONTEXT_SERIES.map(({ key, label, hint }) => ({
        key,
        label,
        color: seriesColor(key),
        value: `≈${formatTokens(Math.round(parts[key]))}`,
        share: share(current.estimate[key], estimate),
        hint,
      }))} />
    </Section>
  )
}

/**
 * One stacked bar per request (or per turn): how the window grew, what it
 * grew with, and where a compaction cut it back. Bars are buttons, so the
 * detail line under the chart follows the keyboard as well as the pointer.
 */
export function ContextTrend({ steps, window }: { steps: readonly ContextStep[]; window: number }) {
  const [by, setBy] = useState<'step' | 'turn'>('step')
  const [hovered, setHovered] = useState<string>()
  const [pinned, setPinned] = useState<string>()
  const bars = trendBars(steps, by)
  const max = niceMax(Math.max(1, ...bars.map(bar => bar.promptTokens)))
  const shown = bars.find(bar => bar.key === hovered) ?? bars.find(bar => bar.key === pinned) ?? bars.at(-1)
  return (
    <Section title="Context trend" aside={<Toggle label="Group the trend by" value={by} options={[['step', 'Step'], ['turn', 'Turn']]} onChange={value => { setBy(value); setPinned(undefined) }} />}>
      {bars.length === 0 ? <p className="muted small">No requests yet. The trend fills in as the agent works.</p> : (
        <>
          <div className="ctx-trend">
            <div className="ctx-trend-axis" aria-hidden>
              <span>{formatTokens(max)}</span>
              <span>{formatTokens(max / 2)}</span>
              <span>0</span>
            </div>
            <div className="ctx-trend-plot" onMouseLeave={() => setHovered(undefined)}>
              {bars.map(bar => {
                const parts = scaled(bar.estimate, bar.promptTokens)
                return (
                  <button
                    key={bar.key}
                    type="button"
                    className={`ctx-trend-bar${shown?.key === bar.key ? ' active' : ''}`}
                    aria-label={`${bar.label}: ${bar.promptTokens.toLocaleString()} tokens sent${bar.compacted ? ', after a compaction' : ''}`}
                    aria-pressed={pinned === bar.key}
                    onMouseEnter={() => setHovered(bar.key)}
                    onFocus={() => setHovered(bar.key)}
                    onBlur={() => setHovered(undefined)}
                    onClick={() => setPinned(current => current === bar.key ? undefined : bar.key)}
                  >
                    {bar.compacted && <Scissors className="ctx-trend-cut" size={10} aria-hidden />}
                    <span className="ctx-trend-stack" style={{ height: `${bar.promptTokens / max * 100}%` }}>
                      {CONTEXT_SERIES.map(({ key }) => parts[key] > 0 && (
                        <span key={key} style={{ flexGrow: parts[key], background: seriesColor(key) }} />
                      ))}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          {shown && <TrendDetail bar={shown} window={window} pinned={pinned === shown.key} />}
        </>
      )}
    </Section>
  )
}

function TrendDetail({ bar, window, pinned }: { bar: TrendBar; window: number; pinned: boolean }) {
  const estimate = total(bar.estimate)
  const top = CONTEXT_SERIES.map(({ key, label }) => ({ key, label, value: bar.estimate[key] }))
    .filter(item => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
  return (
    <div className="ctx-trend-detail" aria-live="polite">
      <div className="ctx-trend-detail-head">
        <strong>{bar.label}</strong>
        <span className="muted small">{new Date(bar.ts).toLocaleTimeString()}{pinned ? ' · pinned' : ''}</span>
      </div>
      <div className="ctx-trend-figures">
        <span><span className="muted">Sent</span> {formatTokens(bar.promptTokens)} <span className="muted">({share(bar.promptTokens, window)} of window)</span></span>
        <span><span className="muted">Output</span> {formatTokens(bar.completionTokens)}</span>
        {bar.cachedTokens !== undefined && <span><span className="muted">Cache</span> {share(bar.cachedTokens, bar.promptTokens)}</span>}
        {bar.compacted && <span className="muted">Compacted before this request</span>}
      </div>
      {top.length > 0 && (
        <p className="muted small ctx-trend-mix">
          Mostly {top.map(item => `${item.label.toLowerCase()} ${share(item.value, estimate)}`).join(', ')}
        </p>
      )}
    </div>
  )
}
