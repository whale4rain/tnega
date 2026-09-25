import { AlertTriangle, ArrowUpRight, CircleDot, Loader2, MessageSquare } from 'lucide-react'
import { MessageBlock } from './reuse'
import { threadStateLabel } from './state'
import type { BootEnvelope, ThreadRecord } from './types'

/**
 * 主对话里的一条消息。用户的发言与协调者的回复都是普通气泡；派工是一条卡片 —— 卡片读
 * Thread 记录，不从模型文本里猜。
 */
export function TimelineEntry({
  envelope,
  thread,
  onOpenThread,
}: {
  envelope: BootEnvelope
  thread?: ThreadRecord
  onOpenThread: (threadId: string) => void
}) {
  if (envelope.kind === 'dispatch') {
    const target = thread?.id ?? envelope.threadId ?? ''
    return (
      <div className="thread-card" data-state={thread?.state ?? 'idle'}>
        <div className="thread-card-icon" aria-hidden="true">
          {thread?.state === 'working'
            ? <Loader2 size={16} className="spin" />
            : thread?.state === 'failed' || thread?.state === 'blocked'
              ? <AlertTriangle size={16} />
              : <CircleDot size={16} />}
        </div>
        <div className="thread-card-body">
          <div className="thread-card-title">
            <span>{thread?.label ?? 'Thread'}</span>
            <span className="thread-card-state">
              {thread ? threadStateLabel(thread.state) : 'starting'}
            </span>
          </div>
          <p className="thread-card-goal">{thread?.goal ?? envelope.text}</p>
          {thread?.detail && <p className="thread-card-detail">{thread.detail}</p>}
        </div>
        <button
          type="button"
          className="thread-card-open"
          onClick={() => onOpenThread(target)}
          disabled={!target}
        >
          Open
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      </div>
    )
  }

  if (envelope.kind === 'notice') {
    return (
      <div className="project-notice">
        <MessageSquare size={14} aria-hidden="true" />
        <span>{envelope.text}</span>
        {envelope.threadId && (
          <button type="button" onClick={() => onOpenThread(envelope.threadId!)}>
            Open thread
          </button>
        )}
      </div>
    )
  }

  const role = envelope.sender.kind === 'user' ? 'user' : 'assistant'
  return (
    <MessageBlock
      message={{
        id: envelope.messageId,
        role,
        content: envelope.text,
      }}
      assistantLabel={thread?.label ?? 'Tnega'}
    />
  )
}

export function Timeline({
  envelopes,
  threads,
  onOpenThread,
}: {
  envelopes: readonly BootEnvelope[]
  threads: readonly ThreadRecord[]
  onOpenThread: (threadId: string) => void
}) {
  const byId = new Map(threads.map(thread => [thread.id, thread]))
  if (!envelopes.length) {
    return (
      <div className="project-empty">
        <p>Ask for something, or hand a piece of work to a thread.</p>
        <p className="project-empty-hint">
          Simple questions get answered right here. Work that deserves its own context becomes a
          thread you can open, steer and keep talking to.
        </p>
      </div>
    )
  }
  return (
    <div className="messages">
      {envelopes.map(envelope => (
        <TimelineEntry
          key={envelope.messageId}
          envelope={envelope}
          {...(byId.get(envelope.threadId ?? '') ? { thread: byId.get(envelope.threadId!)! } : {})}
          onOpenThread={onOpenThread}
        />
      ))}
    </div>
  )
}
