import type { ReactNode } from 'react'

/** One slice of a ring or bar: its value and series colour. */
export interface Segment {
  key: string
  label: string
  value: number
  color: string
}

/**
 * A flat ring: one arc per segment, a thin gap between them, the headline in
 * the middle. The figures are also in the legend beside it, so the ring is
 * labelled as one image rather than read slice by slice.
 */
export function Ring({ segments, label, sublabel, size = 112, title }: {
  segments: readonly Segment[]
  label: ReactNode
  sublabel?: ReactNode
  size?: number
  title: string
}) {
  const stroke = 10
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const sum = segments.reduce((total, segment) => total + Math.max(0, segment.value), 0)
  const visible = segments.filter(segment => segment.value > 0)
  const gap = visible.length > 1 ? Math.min(3, circumference / 120) : 0
  let offset = 0
  return (
    <div className="ctx-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" style={{ stroke: 'var(--surface-sunken)' }} strokeWidth={stroke} />
        {sum > 0 && visible.map(segment => {
          const length = segment.value / sum * circumference
          const dash = Math.max(0.5, length - gap)
          const arc = (
            <circle
              key={segment.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              style={{ stroke: segment.color }}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )
          offset += length
          return arc
        })}
      </svg>
      <div className="ctx-ring-label" aria-hidden>
        <strong>{label}</strong>
        {sublabel && <span>{sublabel}</span>}
      </div>
    </div>
  )
}

/** Legend rows: swatch · name · share, with the absolute figure underneath. */
export function Legend({ items }: { items: ReadonlyArray<{ key: string; label: string; color: string; value: ReactNode; share: string; hint?: string }> }) {
  return (
    <dl className="ctx-legend">
      {items.map(item => (
        <div key={item.key} className="ctx-legend-row" title={item.hint}>
          <dt><span className="ctx-swatch" style={{ background: item.color }} aria-hidden />{item.label}</dt>
          <dd className="ctx-legend-share">{item.share}</dd>
          <dd className="ctx-legend-value">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A horizontal stacked bar measured against `max` (the context window): the
 * unfilled rest is the sunken track, and an optional marker draws where
 * auto-compaction starts.
 */
export function StackedBar({ segments, max, marker, title }: {
  segments: readonly Segment[]
  max: number
  marker?: { at: number; label: string } | undefined
  title: string
}) {
  return (
    <div className="ctx-bar" role="img" aria-label={title}>
      {segments.filter(segment => segment.value > 0).map(segment => (
        <span key={segment.key} className="ctx-bar-part" style={{ width: `${Math.min(100, segment.value / max * 100)}%`, background: segment.color }} />
      ))}
      {marker && marker.at > 0 && marker.at < 1 && (
        <span className="ctx-bar-marker" style={{ left: `${marker.at * 100}%` }} title={marker.label} />
      )}
    </div>
  )
}

/** A small figure tile: label above, value, an optional note below. */
export function Stat({ label, value, note, hint }: { label: string; value: ReactNode; note?: ReactNode; hint?: string }) {
  return (
    <div className="ctx-stat" title={hint}>
      <span className="ctx-stat-label">{label}</span>
      <strong className="ctx-stat-value">{value}</strong>
      {note !== undefined && <span className="ctx-stat-note">{note}</span>}
    </div>
  )
}

/** A titled block of the Context tab or insights page. */
export function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`ctx-section${className ? ` ${className}` : ''}`} aria-label={title}>
      <header className="ctx-section-header">
        <h3>{title}</h3>
        {aside && <div className="ctx-section-aside">{aside}</div>}
      </header>
      {children}
    </section>
  )
}

/** Two to four mutually exclusive options, as a compact switch. */
export function Toggle<T extends string>({ label, value, options, onChange }: {
  label: string
  value: T
  options: ReadonlyArray<readonly [T, string]>
  onChange: (value: T) => void
}) {
  return (
    <div className="ctx-toggle" role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} className={value === option ? 'active' : undefined} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  )
}
