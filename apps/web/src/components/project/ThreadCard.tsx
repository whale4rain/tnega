import { ChevronRight, CircleAlert, CircleCheck, CircleDot, CircleX } from 'lucide-react'
import type { ProjectState } from '../../lib/project-model'
import { threadStatusLine } from '../../lib/project-model'
import type { ThreadRecord } from '../../lib/project-types'

/** The state of a thread as an icon and a few words; while working, the step it is on. */
export function ThreadStatus({ state, thread, withLabel = true }: { state: ProjectState; thread: ThreadRecord; withLabel?: boolean }) {
  const { label, tone, step } = threadStatusLine(state, thread)
  const Icon = tone === 'done' ? CircleCheck : tone === 'failed' ? CircleX : tone === 'attention' ? CircleAlert : CircleDot
  return (
    <span className={`thread-status tone-${tone}`}>
      {tone === 'working' ? <span className="spinner tiny" aria-hidden /> : <Icon size={13} aria-hidden />}
      {withLabel && <span className="thread-status-text">{step ?? label}</span>}
    </span>
  )
}

/**
 * A thread, shown in the main conversation where the work was handed off:
 * its title and its status, nothing else. Everything the thread produces
 * lives behind the card.
 */
export function ThreadCard({
  state,
  threadId,
  active,
  unread,
  onOpen,
}: {
  state: ProjectState
  threadId: string
  active: boolean
  unread: boolean
  onOpen: (id: string) => void
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
  return (
    <button
      type="button"
      className={`thread-card${active ? ' active' : ''}${unread ? ' unread' : ''}`}
      onClick={() => onOpen(threadId)}
      aria-pressed={active}
      title={thread.goal}
    >
      <span className="thread-card-label">{thread.label}</span>
      {unread && <span className="unread-dot" aria-label="New" />}
      <ThreadStatus state={state} thread={thread} />
      <ChevronRight size={15} className="thread-card-chevron" aria-hidden />
    </button>
  )
}
