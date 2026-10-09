import { Markdown } from '../Markdown'
import type { BoxEnvelope } from '../../lib/project-types'
import { ChatRun } from './ChatRun'

/**
 * A thread's conversation: your messages as bubbles, what the Agent that
 * started the thread sent it as dashed bubbles on the same side, and the
 * thread's answers as plain text.
 */
export function ThreadMessages({ messages, label, running, threadId, authorOf }: {
  messages: readonly BoxEnvelope[]
  label: string
  running: boolean
  threadId: string
  authorOf: (id: string) => string
}) {
  return (
    <div className="timeline room" role="log" aria-label="Thread conversation">
      {messages.map(message => {
        const user = message.sender.kind === 'user'
        const relay = !user && message.sender.id !== threadId
        return (
          <ChatRun key={message.messageId} at={message.createdAt} side={user ? 'user' : relay ? 'relay' : 'agent'}
            author={relay ? authorOf(message.sender.id) : undefined}>
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
