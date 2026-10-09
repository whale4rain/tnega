import { Markdown } from '../Markdown'
import type { BoxEnvelope } from '../../lib/project-types'
import { ChatRun } from './ChatRun'

/** A thread's conversation: your messages as bubbles, the thread's answers as plain text. */
export function ThreadMessages({ messages, label, running }: { messages: readonly BoxEnvelope[]; label: string; running: boolean }) {
  return (
    <div className="timeline room" role="log" aria-label="Thread conversation">
      {messages.map(message => {
        const user = message.sender.kind === 'user'
        return (
          <ChatRun key={message.messageId} at={message.createdAt} side={user ? 'user' : 'agent'}>
            <div id={`msg-${message.messageId}`} className="room-message">
              <Markdown text={message.text} />
            </div>
          </ChatRun>
        )
      })}
      {running && <div className="room-typing" role="status"><span className="thinking-dots" aria-hidden><i /><i /><i /></span><span>{label} is working…</span></div>}
    </div>
  )
}
