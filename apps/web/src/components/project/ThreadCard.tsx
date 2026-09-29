import { ChevronRight, CircleAlert, CircleCheck, CircleDot, CircleX, CornerUpLeft, GitFork } from 'lucide-react'
import { AgentAvatar } from '../AgentAvatar'
import type { ProjectState, ReplyRef } from '../../lib/project-model'
import { latestReport, plainPreview, replyRef, THREAD_STATE, threadState } from '../../lib/project-model'
import type { ThreadRecord } from '../../lib/project-types'

export function ThreadStatus({ state, thread, withLabel = true }: { state: ProjectState; thread: ThreadRecord; withLabel?: boolean }) {
  const current = threadState(state, thread)
  const { label, tone } = THREAD_STATE[current]
  const Icon = tone === 'done' ? CircleCheck : tone === 'failed' ? CircleX : tone === 'attention' ? CircleAlert : CircleDot
  return (
    <span className={`thread-status tone-${tone}`}>
      {tone === 'working' ? <span className="spinner tiny" /> : <Icon size={13} />}
      {withLabel && <span>{label}</span>}
    </span>
  )
}

/** A dispatched thread, shown inline in the conversation where it was started. */
export function ThreadCard({
  state,
  threadId,
  active,
  onOpen,
  onReply,
}: {
  state: ProjectState
  threadId: string
  active: boolean
  onOpen: (id: string) => void
  /** Reply in the main conversation to this thread's latest report. */
  onReply?: (ref: ReplyRef) => void
}) {
  const thread = state.threads[threadId]
  if (!thread) {
    return (
      <div className="thread-card pending">
        <span className="thread-card-icon"><GitFork size={15} /></span>
        <span className="muted">Starting thread…</span>
      </div>
    )
  }
  const report = latestReport(state, threadId)
  const live = state.live[threadId]
  const preview = live?.trim() ? live : report?.text ?? thread.detail
  const reportRef = report && !live?.trim() ? replyRef(state, report.messageId) : undefined
  return (
    <div className={`thread-card-wrap${active ? ' active' : ''}`}>
      <button type="button" className={`thread-card${active ? ' active' : ''}`} onClick={() => onOpen(threadId)} aria-pressed={active}>
        <AgentAvatar id={threadId} size={34} live={threadState(state, thread) === 'working'} />
        <span className="thread-card-body">
          <span className="thread-card-top">
            <span className="thread-card-label">{thread.label}</span>
            <ThreadStatus state={state} thread={thread} />
          </span>
          <span className="thread-card-goal">{thread.goal}</span>
          {preview && <span className={`thread-card-report${live?.trim() ? ' live' : ''}`}>{plainPreview(preview)}</span>}
        </span>
        <ChevronRight size={15} className="thread-card-chevron" />
      </button>
      {reportRef && onReply && (
        <button
          type="button"
          className="thread-card-reply"
          onClick={() => onReply(reportRef)}
          title="Reply to this report in the main conversation"
        >
          <CornerUpLeft size={13} /> Reply
        </button>
      )}
    </div>
  )
}

