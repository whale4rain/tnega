import type { ReactNode } from 'react'

/** Consecutive chat bubbles from one author. Users are on the right. */
export function ChatRun({ author, at, avatar, side, children }: {
  author: string
  at: number
  avatar: ReactNode
  side: 'user' | 'agent'
  children: ReactNode
}) {
  return (
    <div className={`room-run room-run-${side}`}>
      <div className="room-avatar">{avatar}</div>
      <div className="room-body">
        <div className="room-head">
          <span className="room-author">{author}</span>
          <time className="room-time" dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
        {children}
      </div>
    </div>
  )
}
