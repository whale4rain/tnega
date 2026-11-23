import { useId } from 'react'

/**
 * The hand layer (tnega-design §3.9): a status drawn with one pen, inside the shape it marks.
 * Each kind has one meaning: `you` (waiting on you, the only mark that loops around something),
 * `working` (hatching fills the circle as it goes), `waiting` (on someone else), `done`, `failed`, `idle`.
 *
 * Marks are drawn again for each size rather than scaled: below 20px they use a simpler stroke
 * (one loop, a solid half, no hatching), so they stay crisp in lists. A mark is never alone: it
 * has a label, read by screen readers and shown as a tooltip; the drawing itself is decoration.
 * A new mark draws itself in once (CSS `pen-draw`), never on scroll or re-render, and simply
 * appears when reduced motion is asked for.
 */
export type PenKind = 'you' | 'working' | 'waiting' | 'done' | 'failed' | 'idle'

export function PenMark({ kind, size = 16, label, progress, className }: {
  kind: PenKind
  size?: number
  /** Accessible name and tooltip. Without one the mark is hidden from assistive tech: text beside it says the same. */
  label?: string | undefined
  /** 0–1 for `working`: how much of the circle is hatched. Unknown progress hatches half. */
  progress?: number | undefined
  className?: string | undefined
}) {
  const small = size < 20
  return (
    <svg
      className={`pen-mark pen-${kind}${small ? ' pen-small' : ''}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      role={label ? 'img' : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      focusable="false"
    >
      {label && <title>{label}</title>}
      <Strokes kind={kind} small={small} progress={progress} />
    </svg>
  )
}

function Strokes({ kind, small, progress }: { kind: PenKind; small: boolean; progress: number | undefined }) {
  const clip = `pen-wedge-${useId().replace(/:/g, '')}`
  switch (kind) {
    case 'you':
      return (
        <>
          <circle className="pen-fill" cx="10" cy="10" r={small ? 3.3 : 3} />
          {/* One loop that does not close: it starts at the top and overshoots, like a pen circling a note. */}
          <path
            className="pen-stroke pen-draw"
            pathLength={1}
            d={small
              ? 'M10.6 2.7c4 0 6.7 3 6.7 7.2s-3 7.2-7.3 7.2S2.8 14 2.8 10 6 2.4 11.2 2.6'
              : 'M10.6 2.6c4.1 0 7 3.1 7 7.4s-3.1 7.3-7.5 7.3S2.6 14.1 2.6 10 5.9 2.2 10.9 2.2c2.8 0 4.8 1.3 5.9 3.1'}
          />
        </>
      )
    case 'working': {
      const share = Math.min(1, Math.max(0.08, progress ?? 0.5))
      return (
        <>
          <circle className="pen-stroke" cx="10" cy="10" r="7" />
          {small
            ? <path className="pen-fill" d={wedge(share, 7)} />
            : (
              <g className="pen-hatch">
                <clipPath id={clip}><path d={wedge(share, 7)} /></clipPath>
                <g clipPath={`url(#${clip})`}>
                  {[-6, -3, 0, 3, 6, 9, 12].map(offset => <path key={offset} className="pen-stroke pen-thin" d={`M${2 + offset} 18L${12 + offset} 2`} />)}
                </g>
              </g>
            )}
        </>
      )
    }
    case 'waiting':
      return <circle className="pen-stroke pen-dashed" cx="10" cy="10" r="7" />
    case 'done':
      return <path className="pen-stroke pen-bold pen-draw" pathLength={1} d="M4.4 10.6l3.7 3.6 7.6-8.6" />
    case 'failed':
      return <path className="pen-stroke pen-bold pen-draw" pathLength={1} d="M5.2 5.4l9.4 9.2M14.8 5.2c-3.2 3-6.3 6.1-9.5 9.5" />
    case 'idle':
      return <circle className="pen-stroke pen-thin" cx="10" cy="10" r="6" />
  }
}

/** A wedge of the circle from twelve o'clock, clockwise, covering `share` of it. */
function wedge(share: number, r: number): string {
  if (share >= 0.999) return `M10 ${10 - r}a${r} ${r} 0 1 1 0 ${2 * r}a${r} ${r} 0 1 1 0 ${-2 * r}Z`
  const angle = share * Math.PI * 2
  const x = 10 + r * Math.sin(angle)
  const y = 10 - r * Math.cos(angle)
  return `M10 10L10 ${10 - r}A${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`
}
