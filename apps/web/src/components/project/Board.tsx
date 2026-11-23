import { CheckCheck, ChevronRight, RotateCcw, Square } from 'lucide-react'
import { useMemo, useState } from 'react'
import { relativeTime } from '../../lib/hooks'
import { projectApi } from '../../lib/project-api'
import {
  boardColumn,
  startOfDay,
  threadActivity,
  threadState,
  workerThreads,
  type ProjectState,
} from '../../lib/project-model'
import type { ThreadRecord } from '../../lib/project-types'
import { EmptyState } from '../EmptyState'
import { PenMark } from '../PenMark'
import { WorkRow, type WorkRowTone } from '../WorkRow'
import { threadMark } from './ThreadCard'

const FINISHED: ReadonlySet<string> = new Set(['done', 'resolved'])

/** The Board's groups, in the order it answers: what needs me, what is moving, what waits elsewhere. */
export interface BoardGroups {
  /** Waiting on you, blocked, failed, or a result you have not opened yet. */
  yours: ThreadRecord[]
  /** Running now. */
  onIt: ThreadRecord[]
  /** Paused, waiting on another agent, a message or a schedule. */
  others: ThreadRecord[]
  /** Finished and read, or resolved. */
  done: ThreadRecord[]
}

/** Threads sorted into the Board's groups, most recently changed first. */
export function boardGroups(state: ProjectState, seen: Readonly<Record<string, number>>): BoardGroups {
  const groups: BoardGroups = { yours: [], onIt: [], others: [], done: [] }
  for (const thread of workerThreads(state)) {
    const column = boardColumn(state, thread, seen)
    const current = threadState(state, thread)
    if (column === 'needs' || column === 'ready') groups.yours.push(thread)
    else if (column === 'working') groups.onIt.push(thread)
    else if (column === 'resolved' || current === 'done') groups.done.push(thread)
    else groups.others.push(thread)
  }
  for (const list of [groups.yours, groups.onIt, groups.others, groups.done]) list.sort((a, b) => b.updatedAt - a.updatedAt)
  return groups
}

/**
 * The Board (work.md): "what needs me, what is moving", in that order. The project's name and how
 * many threads are going; then Your turn, On it and Waiting on others as work rows; then one line,
 * "N done today", which opens the finished threads grouped by day. No progress bars, outputs,
 * tokens or minutes: those live in the thread itself. The Board is not a dashboard.
 */
export function BoardPanel({
  workspace,
  state,
  seen,
  onOpenThread,
}: {
  workspace: string
  state: ProjectState
  seen: Readonly<Record<string, number>>
  onOpenThread: (id: string) => void
}) {
  const projectId = state.project.id
  const groups = useMemo(() => boardGroups(state, seen), [state, seen])
  const total = groups.yours.length + groups.onIt.length + groups.others.length + groups.done.length
  // Going: everything not finished. A result you have not opened is in Your turn but is not going.
  const going = [...groups.yours, ...groups.onIt, ...groups.others]
    .filter(thread => !FINISHED.has(threadState(state, thread))).length
  const [error, setError] = useState<string | undefined>()

  const act = (run: () => Promise<unknown>) => {
    setError(undefined)
    run().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  const actions: RowActions = {
    open: onOpenThread,
    resolve: (id, resolved) => act(() => projectApi.resolveThread(workspace, projectId, id, resolved)),
    stop: id => act(() => projectApi.stopThread(workspace, projectId, id)),
  }

  return (
    <div className="wb-view board" aria-label="Board">
      <div className="wb-card wb-flow wb-scroll board-scroll">
        <header className="board-head">
          <h2 className="board-title">{state.project.name}</h2>
          {going > 0 && <span className="board-going">{going} going</span>}
        </header>
        {error && <div className="notice notice-error"><span>{error}</span></div>}
        {total === 0
          ? <EmptyState arrow="left">Ask for something in the conversation. Each focused task gets its own thread, and it shows up here.</EmptyState>
          : (
            <>
              <Group label="Your turn" threads={groups.yours} state={state} seen={seen} tone="you" actions={actions} />
              <Group label="On it" threads={groups.onIt} state={state} seen={seen} tone="flat" actions={actions} />
              <Group label="Waiting on others" threads={groups.others} state={state} seen={seen} tone="flat" actions={actions} />
              <DoneLine threads={groups.done} state={state} seen={seen} actions={actions} />
            </>
          )}
      </div>
    </div>
  )
}

interface RowActions {
  open: (id: string) => void
  resolve: (id: string, resolved: boolean) => void
  stop: (id: string) => void
}

function Group({ label, threads, state, seen, tone, actions }: {
  label: string
  threads: ThreadRecord[]
  state: ProjectState
  seen: Readonly<Record<string, number>>
  tone: WorkRowTone
  actions: RowActions
}) {
  if (threads.length === 0) return null
  return (
    <section className="board-group" aria-label={label}>
      <h3 className="board-group-head">{label} <span className="count">{threads.length}</span></h3>
      <div className="board-rows">
        {threads.map(thread => <BoardRow key={thread.id} thread={thread} state={state} seen={seen} tone={tone} actions={actions} />)}
      </div>
    </section>
  )
}

function BoardRow({ thread, state, seen, tone, actions }: {
  thread: ThreadRecord
  state: ProjectState
  seen: Readonly<Record<string, number>>
  tone: WorkRowTone
  actions: RowActions
}) {
  const mark = threadMark(state, thread)
  const current = threadState(state, thread)
  const column = boardColumn(state, thread, seen)
  return (
    <WorkRow
      mark={mark.kind}
      markLabel={mark.label}
      progress={mark.progress}
      title={thread.label}
      line={threadActivity(state, thread)}
      failed={current === 'failed'}
      time={relativeTime(thread.updatedAt)}
      tone={tone}
      hint={thread.goal}
      onOpen={() => actions.open(thread.id)}
      actions={(
        <>
          {column === 'working' && (
            <button type="button" className="icon-button round" aria-label={`Stop ${thread.label}`} title="Stop this thread" onClick={() => actions.stop(thread.id)}>
              <Square size={12} fill="currentColor" />
            </button>
          )}
          {column === 'resolved' && (
            <button type="button" className="icon-button round" aria-label={`Reopen ${thread.label}`} title="Reopen" onClick={() => actions.resolve(thread.id, false)}>
              <RotateCcw size={14} />
            </button>
          )}
          {column !== 'working' && column !== 'resolved' && (
            <button type="button" className="icon-button round" aria-label={`Resolve ${thread.label}`} title="Mark resolved: you took the result" onClick={() => actions.resolve(thread.id, true)}>
              <CheckCheck size={14} />
            </button>
          )}
        </>
      )}
    />
  )
}

/** "7 done today": one line that opens the finished threads, as flat rows grouped by day. */
function DoneLine({ threads, state, seen, actions }: {
  threads: ThreadRecord[]
  state: ProjectState
  seen: Readonly<Record<string, number>>
  actions: RowActions
}) {
  const [open, setOpen] = useState(false)
  if (threads.length === 0) return null
  const today = startOfDay(Date.now())
  const doneToday = threads.filter(thread => thread.updatedAt >= today).length
  const days = new Map<number, ThreadRecord[]>()
  for (const thread of threads) {
    const day = startOfDay(thread.updatedAt)
    days.set(day, [...(days.get(day) ?? []), thread])
  }
  return (
    <section className={`board-done${open ? ' open' : ''}`} aria-label="Done">
      <button type="button" className="board-done-line" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <PenMark kind="done" size={16} />
        <span>{doneToday > 0 ? `${doneToday} done today` : `${threads.length} done`}</span>
        <ChevronRight size={14} className="chevron" aria-hidden />
      </button>
      {open && [...days.entries()].map(([day, list]) => (
        <div key={day} className="board-day">
          <h4 className="board-day-head">{dayLabel(day, today)}</h4>
          <div className="board-rows">
            {list.map(thread => <BoardRow key={thread.id} thread={thread} state={state} seen={seen} tone="flat" actions={actions} />)}
          </div>
        </div>
      ))}
    </section>
  )
}

function dayLabel(day: number, today: number): string {
  if (day === today) return 'Today'
  if (today - day <= 86_400_000 + 3_600_000) return 'Yesterday'
  return new Date(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}
