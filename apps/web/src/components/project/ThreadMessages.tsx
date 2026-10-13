import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { Markdown } from '../Markdown'
import type { ProjectState } from '../../lib/project-model'
import type { BoxEnvelope } from '../../lib/project-types'
import { ChatRun } from './ChatRun'
import { Reactions } from './Reactions'

/**
 * A thread's conversation: your messages as bubbles, the thread's reports as
 * plain text, and what the Agent that started the thread sent it as a folded
 * one-line note that opens on click.
 */
export function ThreadMessages({ messages, label, running, threadId, goal, authorOf, workspace, state }: {
  messages: readonly BoxEnvelope[]
  label: string
  running: boolean
  threadId: string
  /** The brief; the note that carries it is named "Brief" instead of "Message". */
  goal?: string
  authorOf: (id: string) => string
  workspace?: string
  state?: ProjectState
}) {
  return (
    <div className="timeline room" role="log" aria-label="Thread conversation">
      {messages.map(message => {
        const user = message.sender.kind === 'user'
        if (!user && message.sender.id !== threadId) {
          return <RelayNote key={message.messageId} message={message} author={authorOf(message.sender.id)}
            brief={goal !== undefined && message.text.startsWith(goal)} />
        }
        return (
          <ChatRun key={message.messageId} at={message.createdAt} side={user ? 'user' : 'agent'}>
            <div className={user ? 'room-bubble reactable' : 'room-message reactable'} {...(user ? {} : { id: `msg-${message.messageId}` })}>
              {user
                ? <div id={`msg-${message.messageId}`} className="room-message"><Markdown text={message.text} /></div>
                : <Markdown text={message.text} />}
              {workspace !== undefined && state && (
                <Reactions workspace={workspace} state={state} messageId={message.messageId} align={user ? 'end' : 'start'} />
              )}
            </div>
          </ChatRun>
        )
      })}
      {running && <div className="room-typing" role="status"><span className="thinking-dots" aria-hidden><i /><i /><i /></span><span>{label} is working…</span></div>}
    </div>
  )
}

/**
 * What the Agent that started this thread sent it, folded to one quiet line
 * ("Message from Coordinator ⌄"). It is an instruction to the thread, not news
 * for you, so it stays out of the way until opened (tnega-design §5.1).
 */
function RelayNote({ message, author, brief }: { message: BoxEnvelope; author: string; brief: boolean }) {
  const [open, setOpen] = useState(false)
  const time = new Date(message.createdAt)
  const what = brief ? 'Brief' : 'Message'
  return (
    <div id={`msg-${message.messageId}`} className={`relay-note${open ? ' open' : ''}`}>
      <button type="button" className="relay-note-head" onClick={() => setOpen(value => !value)} aria-expanded={open}
        aria-label={`${what} from ${author}`}>
        <span>{what} from {author}</span>
        <ChevronDown size={12} className="relay-note-chevron" aria-hidden />
        <time className="relay-note-time" dateTime={time.toISOString()}>{time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
      </button>
      {open && (
        <div className="relay-note-body">
          <span className="relay-note-author">{author}</span>
          <Markdown text={message.text} />
        </div>
      )}
    </div>
  )
}
