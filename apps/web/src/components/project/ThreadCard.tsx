import { CornerUpLeft } from 'lucide-react'
import type { ProjectState, ReplyRef } from '../../lib/project-model'
import { plainPreview, threadActivity, threadState, threadStatusLine } from '../../lib/project-model'
import { relativeTime } from '../../lib/hooks'
import type { ThreadRecord } from '../../lib/project-types'
import { PenMark, type PenKind } from '../PenMark'
import { WorkRow } from '../WorkRow'

const STATUS_MARK: Record<string, PenKind> = { done: 'done', failed: 'failed', attention: 'you', working: 'working' }

/**
 * A thread's pen mark and its name (hand-layer.md): waiting on you or blocked is `you`, running is
 * `working`, idle waits on someone else, finished is a tick, failed a cross.
 */
export function threadMark(state: ProjectState, thread: ThreadRecord): { kind: PenKind; label: string; progress?: number } {
  const current = threadState(state, thread)
  switch (current) {
    case 'waiting': return { kind: 'you', label: 'Waiting on you' }
    case 'blocked': return { kind: 'you', label: 'Blocked: needs you' }
    case 'failed': return { kind: 'failed', label: 'Failed' }
    case 'working': {
      const items = thread.checklist ?? []
      const done = items.filter(item => item.status === 'done').length
      return items.length ? { kind: 'working', label: 'Working', progress: done / items.length } : { kind: 'working', label: 'Working' }
    }
    case 'idle': return { kind: 'waiting', label: 'Waiting on others' }
    case 'done': return { kind: 'done', label: 'Done' }
    case 'resolved': return { kind: 'done', label: 'Resolved' }
  }
}

/**
 * The state of a thread as a pen mark and a few words; while working, the step it is on. Used where
 * a thread is shown on its own (the thread view's header); work rows draw their own mark.
 */
export function ThreadStatus({ state, thread, withLabel = true, mark = true }: { state: ProjectState; thread: ThreadRecord; withLabel?: boolean; mark?: boolean }) {
  const { label, tone, step } = threadStatusLine(state, thread)
  return (
    <span className={`thread-status tone-${tone}`}>
      {mark && <PenMark kind={STATUS_MARK[tone] ?? 'idle'} size={16} />}
      {withLabel && <span className="thread-status-text">{step ?? label}</span>}
    </span>
  )
}

/**
 * A thread, shown in the main conversation where the work was handed off: a work row inside a
 * white card (work.md). Clicking opens the thread in the Workbench; the open one is tinted.
 * "Reply in this thread" is a round button that appears on hover at the right.
 */
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
  /** Thread id → the `updatedAt` the user last saw. Accepted for callers; the card shows state, not unread. */
  seen?: Readonly<Record<string, number>>
  onOpen: (id: string) => void
  /** Reply to the thread itself: the message goes straight to it. */
  onReply?: (ref: ReplyRef) => void
}) {
  const thread = state.threads[threadId]
  if (!thread) {
    return (
      <div className="thread-card pending" role="status">
        <span className="work-row-mark"><PenMark kind="waiting" size={20} /></span>
        <span className="work-row-title">Starting a thread…</span>
      </div>
    )
  }
  const mark = threadMark(state, thread)
  const current = threadState(state, thread)
  const yours = mark.kind === 'you'
  return (
    <div className={`thread-card${active ? ' active' : ''}${yours ? ' yours' : ''}`}>
      <WorkRow
        mark={mark.kind}
        markLabel={mark.label}
        progress={mark.progress}
        title={thread.label}
        line={threadActivity(state, thread)}
        failed={current === 'failed'}
        time={relativeTime(thread.updatedAt)}
        tone={yours ? 'you' : 'flat'}
        pressed={active}
        label={`Open thread ${thread.label}: ${mark.label}`}
        hint={thread.goal}
        onOpen={() => onOpen(threadId)}
        actions={onReply && (
          <button
            type="button"
            className="icon-button round thread-card-reply"
            aria-label={`Reply to ${thread.label}`}
            title="Reply in this thread"
            onClick={() => onReply({ id: `thread:${thread.id}`, who: 'thread', label: thread.label, agentId: thread.id, threadId: thread.id, excerpt: plainPreview(thread.goal, 110), inMain: false })}
          >
            <CornerUpLeft size={14} />
          </button>
        )}
      />
    </div>
  )
}
