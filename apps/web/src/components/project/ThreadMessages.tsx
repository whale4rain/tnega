import { AgentAvatar } from '../AgentAvatar'
import { Markdown } from '../Markdown'
import type { BoxEnvelope } from '../../lib/project-types'
import { ChatRun } from './ChatRun'

export function ThreadMessages({ messages, label, running }: { messages: readonly BoxEnvelope[]; label: string; running: boolean }) {
  return (
    <div className="timeline room" role="log" aria-label="Thread conversation">
      {messages.map(message => {
        const user = message.sender.kind === 'user'
        return (
          <ChatRun key={message.messageId} author={user ? 'You' : label} at={message.createdAt} side={user ? 'user' : 'agent'}
            avatar={user ? <span className="room-avatar-you" aria-hidden>Y</span> : <AgentAvatar id={message.sender.id} size={26} />}>
            <div id={`msg-${message.messageId}`} className="room-message">
              <Markdown text={message.text} />
            </div>
          </ChatRun>
        )
      })}
      {running && <div className="room-typing" role="status"><span className="thinking-dots" aria-hidden><i /><i /><i /></span><span>{label} is typing…</span></div>}
    </div>
  )
}
