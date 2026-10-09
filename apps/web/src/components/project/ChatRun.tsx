import type { ReactNode } from 'react'

/**
 * Consecutive messages from one author. The user's are bubbles on the right
 * with their time; an Agent's are plain text across the column, with no
 * avatar or bubble, and a name only where several Agents speak. A relay —
 * what the Agent that started a thread asks of it — sits on the asking side
 * too, as a dashed bubble with its sender's name: an instruction like yours,
 * but not written by you.
 */
export function ChatRun({ author, at, side, children }: {
  author?: string | undefined
  at: number
  side: 'user' | 'agent' | 'relay'
  children: ReactNode
}) {
  const time = new Date(at)
  return (
    <div className={`room-run room-run-${side}`}>
      {(side !== 'agent' || author) && (
        <div className="room-head">
          {author && <span className="room-author">{author}</span>}
          <time className="room-time" dateTime={time.toISOString()}>{time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
      )}
      {children}
    </div>
  )
}
