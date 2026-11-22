import type { ReactNode } from 'react'
import { PenMark } from './PenMark'

/** Which way the drawn arrow points: toward the one thing to do. */
export type ArrowDirection = 'left' | 'right' | 'up' | 'down'

/**
 * An empty room, where the hand speaks (welcome-and-empty.md): a small drawn arrow pointing toward
 * the action, one sentence in reading size, and at most one sunken button. Centred in its card;
 * no icon in a circle, no grey small print.
 */
export function EmptyState({ arrow = 'left', children, action, className }: {
  arrow?: ArrowDirection | false
  /** The one sentence. */
  children: ReactNode
  /** At most one button, rendered sunken. */
  action?: { label: string; onClick: () => void } | undefined
  className?: string | undefined
}) {
  return (
    <div className={`wb-empty${className ? ` ${className}` : ''}`}>
      {arrow && <DrawnArrow direction={arrow} />}
      <p>{children}</p>
      {action && <button type="button" className="button secondary" onClick={action.onClick}>{action.label}</button>}
    </div>
  )
}

/** The pen's arrow (80×40, 2 px): one curved stroke and an open head, drawn once. */
export function DrawnArrow({ direction = 'left' }: { direction?: ArrowDirection }) {
  return (
    <svg className={`pen-mark pen-arrow pen-arrow-${direction}`} width="80" height="40" viewBox="0 0 80 40" aria-hidden focusable="false">
      <path className="pen-stroke pen-draw" pathLength={1} d="M74 31c-12 5-27 4-39-2S17 15 9 12" />
      <path className="pen-stroke pen-draw" pathLength={1} d="M18.5 8.2L9 12l5.4 8.6" />
    </svg>
  )
}

/**
 * Loading, in the hand layer: the `working` mark with what is loading in words ("Reading the
 * folder…"). No spinner beside text.
 */
export function Loading({ children, size = 28 }: { children: ReactNode; size?: number }) {
  return (
    <div className="wb-loading" role="status">
      <PenMark kind="working" size={size} />
      <span>{children}</span>
    </div>
  )
}
