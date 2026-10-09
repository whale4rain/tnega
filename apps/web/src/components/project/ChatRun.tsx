import type { ReactNode } from 'react'

/**
 * Consecutive messages from one author. The user's are bubbles on the right
 * with their time; an Agent's are plain text across the column, with no
 * avatar or bubble, and a name only where several Agents speak.
 */
export function ChatRun({ author, at, side, children }: {
  author?: string | undefined
  at: number
  side: 'user' | 'agent'
  children: ReactNode
}) {
  const time = new Date(at)
  return (
    <div className={`room-run room-run-${side}`}>
      {(side === 'user' || author) && (
        <div className="room-head">
          {author && <span className="room-author">{author}</span>}
          <time className="room-time" dateTime={time.toISOString()}>{time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
      )}
      {children}
    </div>
  )
}
