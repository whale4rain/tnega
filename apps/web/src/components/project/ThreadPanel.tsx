import { ArrowLeft, Square, Target } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorText } from '../../lib/hooks'
import { isUnsupported, projectApi } from '../../lib/project-api'
import type { ProjectState } from '../../lib/project-model'
import { threadState } from '../../lib/project-model'
import type { SessionEvent } from '../../lib/types'
import { fromEvents, type Entry } from '../../lib/timeline'
import { PromptBox } from '../Composer'
import { AgentAvatar } from '../AgentAvatar'
import { Timeline } from '../Timeline'
import { ThreadStatus } from './ThreadCard'

/**
 * One thread, opened beside the conversation: its goal, its own Session as a
 * timeline, and a box to steer it directly.
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

  const entries = useMemo(() => {
    const base: Entry[] = events ? fromEvents(events) : []
    const live = state.live[threadId]
    if (!live?.trim()) return base
    const last = base.at(-1)
    const draft = { kind: 'text' as const, id: 'live-draft', text: live, streaming: true }
    if (last?.kind === 'agent') return [...base.slice(0, -1), { ...last, blocks: [...last.blocks, draft], status: 'running' as const }]
    return [...base, { kind: 'agent' as const, id: 'live-agent', blocks: [draft], status: 'running' as const }]
  }, [events, state.live, threadId])

  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [entries])

  if (!thread) {
    return (
      <div className="side-panel">
        <div className="side-header"><button type="button" className="icon-button" onClick={onBack} aria-label="Back"><ArrowLeft size={16} /></button><span className="muted">Thread not found</span></div>
      </div>
    )
  }

  const working = threadState(state, thread) === 'working'
  const send = async (text: string) => {
    try {
      await projectApi.sendToThread(workspace, projectId, threadId, text)
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
    <div className="side-panel thread-panel">
      <div className="side-header">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back to overview" title="Back to overview"><ArrowLeft size={16} /></button>
        <AgentAvatar id={threadId} size={34} live={working} rerollable />
        <div className="side-titles">
          <div className="side-title">{thread.label}</div>
          <ThreadStatus state={state} thread={thread} />
        </div>
        {working && (
          <button type="button" className="button ghost small" onClick={() => void stop()} title="Stop this thread">
            <Square size={11} fill="currentColor" /> Stop
          </button>
        )}
      </div>
      <div className="side-scroll" ref={scroller}>
        <div className="thread-goal">
          <div className="thread-goal-head"><Target size={13} /> Goal</div>
          <p>{thread.goal}</p>
          {thread.expect && <p className="thread-expect"><strong>Report back:</strong> {thread.expect}</p>}
          <div className="thread-meta">
            <span>{thread.permission}</span>
            {thread.depth > 1 && <span>depth {thread.depth}</span>}
            {thread.detail && <span title={thread.detail}>{thread.detail}</span>}
          </div>
        </div>
        {notice && <div className="notice notice-info">{notice}</div>}
        {error && <div className="error-banner">{error}</div>}
        {!events && !error && <div className="skeleton"><div className="skeleton-line w90" /><div className="skeleton-line w60" /></div>}
        {events && events.length === 0 && !state.live[threadId] && <p className="muted small">This thread hasn't started yet.</p>}
        <Timeline entries={entries} running={working} actions={{}} agent={{ id: threadId }} />
      </div>
      <div className="side-dock">
        <PromptBox
          compact
          placeholder={`Message ${thread.label}…`}
          onSubmit={send}
          autoFocusKey={threadId}
        />
      </div>
    </div>
  )
}
