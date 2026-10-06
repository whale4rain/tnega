import { ArrowLeft, Check, CheckCheck, ChevronRight, RotateCcw, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorText } from '../../lib/hooks'
import { isUnsupported, projectApi } from '../../lib/project-api'
import type { ProjectState } from '../../lib/project-model'
import { threadArtifacts, threadState } from '../../lib/project-model'
import type { ChecklistItem } from '../../lib/project-types'
import type { SessionEvent } from '../../lib/types'
import { fromEvents, type Entry } from '../../lib/timeline'
import { PromptBox } from '../Composer'
import { Timeline } from '../Timeline'
import { ArtifactCards } from './Artifacts'
import { ThreadStatus } from './ThreadCard'
import { ThreadMessages } from './ThreadMessages'

/**
 * One thread, opened beside the conversation. Outcomes come first: its live
 * checklist, the outputs it published and its answers. The brief and every
 * internal step stay folded until asked for.
 */
export function ThreadPanel({
  workspace,
  state,
  threadId,
  onBack,
}: {
  workspace: string
  state: ProjectState
  threadId: string
  onBack: () => void
}) {
  const thread = state.threads[threadId]
  const [events, setEvents] = useState<SessionEvent[] | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const projectId = state.project.id

  const load = useCallback(() => {
    projectApi.thread(workspace, projectId, threadId).then(detail => {
      setEvents(detail.events)
      setError(undefined)
    }, reason => setError(errorText(reason)))
  }, [workspace, projectId, threadId])

  useEffect(() => {
    setEvents(undefined)
    setNotice(undefined)
    load()
  }, [load])

  // Reload the thread's Session whenever something about it changes.
  const running = state.running[threadId]
  const updatedAt = thread?.updatedAt
  const threadMessages = state.messages.length + state.reports.length
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(load, 250)
    return () => clearTimeout(timer.current)
  }, [running, updatedAt, threadMessages, load])

  // The parent's brief is the thread's first input; it is shown folded above, not as a message.
  const goal = thread?.goal
  const entries = useMemo<Entry[]>(() => {
    const all = events ? fromEvents(events) : []
    return goal ? all.filter(entry => !(entry.kind === 'user' && entry.text.startsWith(goal))) : all
  }, [events, goal])
  const outputs = useMemo(() => threadArtifacts(state, threadId), [state, threadId])
  const messages = useMemo(() => Object.values(state.envelopes)
    .filter(envelope => envelope.placement.kind === 'thread' && envelope.placement.threadId === threadId
      && (envelope.kind === 'user-thread' || envelope.kind === 'agent-reply'))
    .sort((a, b) => a.createdAt - b.createdAt), [state.envelopes, threadId])

  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [entries, messages])

  if (!thread) {
    return (
      <div className="wb-view">
        <div className="wb-toolbar"><button type="button" className="icon-button small" onClick={onBack} aria-label="Back to the Board"><ArrowLeft size={15} /></button><span className="muted">Thread not found</span></div>
      </div>
    )
  }

  const current = threadState(state, thread)
  const working = current === 'working'
  const resolve = async (resolved: boolean) => {
    try {
      await projectApi.resolveThread(workspace, projectId, threadId, resolved)
    } catch (reason) {
      setNotice(isUnsupported(reason) ? 'Resolving a thread is not supported by this server yet.' : errorText(reason))
    }
  }
  const send = async (text: string, interrupt = false) => {
    try {
      await projectApi.sendToThread(workspace, projectId, threadId, text, interrupt)
      return true
    } catch (reason) {
      setError(errorText(reason))
      return false
    }
  }
  const stop = async () => {
    try {
      await projectApi.stopThread(workspace, projectId, threadId)
    } catch (reason) {
      setNotice(isUnsupported(reason) ? 'Stopping a single thread is not supported by this server yet.' : errorText(reason))
    }
  }

  return (
    <div className="wb-view thread-panel" aria-label={`Thread ${thread.label}`}>
      <div className="wb-toolbar">
        <button type="button" className="icon-button small" onClick={onBack} aria-label="Back to the Board" title="Back to the Board"><ArrowLeft size={15} /></button>
        <span className="wb-toolbar-title" title={thread.goal}>{thread.label}</span>
        <ThreadStatus state={state} thread={thread} />
        {working && (
          <button type="button" className="button ghost small" onClick={() => void stop()} title="Stop this thread">
            <Square size={11} fill="currentColor" /> Stop
          </button>
        )}
        {!working && (current === 'resolved'
          ? <button type="button" className="button ghost small" onClick={() => void resolve(false)} title="Reopen this thread"><RotateCcw size={12} /> Reopen</button>
          : <button type="button" className="button ghost small" onClick={() => void resolve(true)} title="You took the result: move it to Resolved"><CheckCheck size={13} /> Resolve</button>)}
      </div>
      <div className="wb-card thread-body">
      <div className="side-scroll" ref={scroller}>
        {thread.checklist && thread.checklist.length > 0 && <Checklist items={thread.checklist} working={working} />}
        {outputs.length > 0 && (
          <section className="thread-outputs" aria-label="Outputs">
            <ArtifactCards workspace={workspace} projectId={projectId} artifacts={outputs} />
          </section>
        )}
        <Brief goal={thread.goal} />
        {notice && <div className="notice notice-info">{notice}</div>}
        {error && <div className="error-banner">{error}</div>}
        {!events && !error && <div className="skeleton"><div className="skeleton-line w90" /><div className="skeleton-line w60" /></div>}
        {events && events.length === 0 && <p className="muted small">Starting up…</p>}
        <ThreadMessages messages={messages} label={thread.label} running={working} />
        <details className="thread-execution">
          <summary>Execution details</summary>
          <Timeline entries={entries} running={working} actions={{}} agent={{ id: threadId }} outcomeFirst />
        </details>
      </div>
      <div className="side-dock">
        <PromptBox
          inline
          placeholder={`Message ${thread.label}…`}
          onSubmit={text => send(text)}
          onInterruptSubmit={text => send(text, true)}
          onStop={() => void stop()}
          running={working}
          allowWhileRunning
          autoFocusKey={threadId}
        />
      </div>
      </div>
    </div>
  )
}

/** The thread's live checklist: what it is doing now, what is done, what is next. */
function Checklist({ items, working }: { items: readonly ChecklistItem[]; working: boolean }) {
  const done = items.filter(item => item.status === 'done').length
  return (
    <div className="plan-panel open thread-checklist">
      <div className="plan-head">
        <span className="plan-title">Checklist</span>
        <span className="plan-count">{done}/{items.length}</span>
      </div>
      <ol className="plan-items">
        {items.map((item, index) => {
          const status = item.status === 'active' && working ? 'running' : item.status
          return (
            <li key={`${index}-${item.title}`} className={`plan-item status-${status}`}>
              <span className="plan-check">
                {item.status === 'done' ? <Check size={11} strokeWidth={3} /> : status === 'running' ? <span className="spinner tiny" aria-hidden /> : null}
              </span>
              <span>{item.title}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** What the thread was asked to do, folded: it is context, not news. */
function Brief({ goal }: { goal: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`thread-brief${open ? ' open' : ''}`}>
      <button type="button" className="thread-brief-head" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <ChevronRight size={13} className="chevron" />
        <span>Brief</span>
      </button>
      {open && <p className="thread-brief-text">{goal}</p>}
    </div>
  )
}
