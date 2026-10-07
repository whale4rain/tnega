import { ArrowLeftRight, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { agentLabel, artifactsFor, exchangeMessages, type ProjectState } from '../../lib/project-model'
import type { BoxEnvelope } from '../../lib/project-types'
import { AgentAvatar } from '../AgentAvatar'
import { Markdown } from '../Markdown'
import { ArtifactCards } from './Artifacts'
import { ChatRun } from './ChatRun'

/** Inspect the durable messages between two Agents, separate from direct user chat. */
export function ExchangePanel({ state, workspace, firstId, secondId, onOpenThread, onClose }: {
  state: ProjectState
  workspace: string
  firstId: string
  secondId: string
  onOpenThread: (id: string) => void
  onClose: () => void
}) {
  const messages = exchangeMessages(state, firstId, secondId)
  const groups: BoxEnvelope[][] = []
  for (const message of messages) {
    const last = groups.at(-1)
    const previous = last?.at(-1)
    if (last && previous?.sender.id === message.sender.id && message.createdAt - previous.createdAt < 5 * 60_000) last.push(message)
    else groups.push([message])
  }
  const scroll = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = scroll.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages.length])
  const participant = (id: string) => (
    <button type="button" className="exchange-participant" onClick={() => onOpenThread(id)} aria-label={`Open ${agentLabel(state, id)}`}>
      <AgentAvatar id={id} role={id === state.coordinatorId ? 'coordinator' : 'agent'} size={22} />
      <span>{agentLabel(state, id)}</span>
    </button>
  )
  return (
    <div className="wb-view exchange-panel">
      <div className="wb-toolbar exchange-toolbar">
        <div className="exchange-pair">{participant(firstId)}<ArrowLeftRight size={13} aria-hidden />{participant(secondId)}</div>
        <button type="button" className="icon-button small" aria-label="Close chat" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="wb-card exchange-body" ref={scroll} onScroll={() => {
        const el = scroll.current
        if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}>
        <div className="timeline room" role="log" aria-label="Agent conversation">
          {groups.map(group => {
            const first = group[0]!
            const coordinator = first.sender.id === state.coordinatorId
            return (
              <ChatRun key={first.messageId} author={agentLabel(state, first.sender.id)} at={first.createdAt} side="agent"
                avatar={<AgentAvatar id={first.sender.id} role={coordinator ? 'coordinator' : 'agent'} size={24} />}>
                {group.map(message => (
                  <div key={message.messageId} className="room-message">
                    <Markdown text={message.text} />
                    <ArtifactCards workspace={workspace} projectId={state.project.id} artifacts={artifactsFor(state, message.refs)} />
                  </div>
                ))}
              </ChatRun>
            )
          })}
          {!messages.length && <p className="muted small">No messages between these Agents yet.</p>}
        </div>
      </div>
    </div>
  )
}
