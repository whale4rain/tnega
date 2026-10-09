import { ChevronRight, CircleAlert, CircleCheck, CircleDot, CircleX, CornerUpLeft } from 'lucide-react'
import type { ProjectState, ReplyRef } from '../../lib/project-model'
import { LIGHT_LABEL, plainPreview, threadLight, threadStatusLine } from '../../lib/project-model'
import type { ThreadRecord } from '../../lib/project-types'
import { StatusLight } from '../StatusLight'

/** The state of a thread as an icon and a few words; while working, the step it is on. */
export function ThreadStatus({ state, thread, withLabel = true }: { state: ProjectState; thread: ThreadRecord; withLabel?: boolean }) {
  const { label, tone, step } = threadStatusLine(state, thread)
  const Icon = tone === 'done' ? CircleCheck : tone === 'failed' ? CircleX : tone === 'attention' ? CircleAlert : CircleDot
  return (
    <span className={`thread-status tone-${tone}`}>
      {tone === 'working' ? <span className="spinner tiny" aria-hidden /> : <Icon size={12} aria-hidden />}
      {withLabel && <span className="thread-status-text">{step ?? label}</span>}
    </span>
  )
}

/**
 * A thread, shown in the main conversation where the work was handed off: a
 * link that opens the thread, with its status light, title and current step.
 * Everything the thread produces lives behind it.
 */
export function ThreadCard({
  state,
  threadId,
  active,
  seen,
  onOpen,
  onReply,
}: {
  state: ProjectState
  threadId: string
  active: boolean
  /** Thread id → the `updatedAt` the user last saw, so an unopened result lights up. */
  seen?: Readonly<Record<string, number>>
  onOpen: (id: string) => void
  /** Reply to the thread itself: the message goes straight to it. */
  onReply?: (ref: ReplyRef) => void
}) {
  const thread = state.threads[threadId]
  if (!thread) {
    return (
      <div className="thread-card pending" role="status">
        <span className="thread-status tone-working"><span className="spinner tiny" aria-hidden /></span>
        <span className="thread-card-label muted">Starting a thread…</span>
      </div>
    )
  }
  const light = threadLight(state, thread, seen)
  return (
    <div className="thread-card-wrap">
      <button
        type="button"
        className={`thread-card light-${light}${active ? ' active' : ''}`}
        onClick={() => onOpen(threadId)}
        aria-pressed={active}
        aria-label={`Open thread ${thread.label}: ${LIGHT_LABEL[light]}`}
        title={thread.goal}
      >
        <StatusLight tone={light} label={LIGHT_LABEL[light]} />
        <span className="thread-card-label">{thread.label}</span>
        <ThreadStatus state={state} thread={thread} />
        <ChevronRight size={14} className="thread-card-chevron" aria-hidden />
      </button>
      {onReply && (
        <button
          type="button"
          className="thread-card-reply icon-button tiny"
          aria-label={`Reply to ${thread.label}`}
          title="Reply in this thread"
          onClick={() => onReply({ id: `thread:${thread.id}`, who: 'thread', label: thread.label, agentId: thread.id, threadId: thread.id, excerpt: plainPreview(thread.goal, 110), inMain: false })}
        >
          <CornerUpLeft size={12} />
        </button>
      )}
    </div>
  )
}
