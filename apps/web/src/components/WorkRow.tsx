import type { ReactNode } from 'react'
import { PenMark, type PenKind } from './PenMark'

/**
 * Where a piece of work stands, as the row draws it (docs/design/umbrella/work.md): `you` is a
 * white row with the title in 600, `selected` is sunken, `flat` sits on the panel.
 */
export type WorkRowTone = 'you' | 'selected' | 'flat'

/**
 * The work row: the one component for "a piece of work". One pen mark (20) says the state, the
 * title over what it is doing now, and the time at the right. The mark appears once; nothing else
 * on the row repeats the state. The whole row is one button; `actions` are round buttons that
 * appear on hover or focus at the right, over the time.
 */
export function WorkRow({
  mark,
  markLabel,
  progress,
  title,
  line,
  failed = false,
  time,
  timeTitle,
  tone = 'flat',
  pressed,
  label,
  hint,
  onOpen,
  actions,
  className,
}: {
  mark: PenKind
  /** The mark's tooltip; the row's own label says the same for screen readers. */
  markLabel: string
  progress?: number | undefined
  title: string
  /** The current step, the question, the result, or the reason it failed. */
  line?: string | undefined
  /** The second line is a failure reason: it takes the danger tone. */
  failed?: boolean
  time?: string | undefined
  timeTitle?: string | undefined
  tone?: WorkRowTone
  /** For a row that toggles what the panel shows (a thread card). */
  pressed?: boolean | undefined
  /** The row button's accessible name; defaults to the title and the state. */
  label?: string | undefined
  /** Tooltip over the row. */
  hint?: string | undefined
  onOpen: () => void
  actions?: ReactNode
  className?: string | undefined
}) {
  return (
    <div className={`work-row tone-${tone}${actions ? ' has-actions' : ''}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="work-row-main"
        onClick={onOpen}
        aria-pressed={pressed}
        aria-label={label ?? `${title}: ${markLabel}`}
        title={hint}
      >
        <span className="work-row-mark" title={markLabel}>
          <PenMark kind={mark} size={20} progress={progress} />
        </span>
        <span className="work-row-text">
          <span className="work-row-title">{title}</span>
          {line && <span className={`work-row-line${failed ? ' failed' : ''}`}>{line}</span>}
        </span>
        {time && <span className="work-row-time" title={timeTitle}>{time}</span>}
      </button>
      {actions && <span className="work-row-actions">{actions}</span>}
    </div>
  )
}
