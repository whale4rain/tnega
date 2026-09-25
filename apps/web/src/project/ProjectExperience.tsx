import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import { GlobalSidebar } from './GlobalSidebar'
import { MainWorkspace, type SidePanel } from './MainWorkspace'
import { ThreadPanel } from './ThreadPanel'
import { latestPlanFromEvents } from './reuse'
import { LibraryPanel, MemoryPanel, OverviewPanel } from './SidePanels'
import { applyStreamEvent, fromSnapshot, mergeMessage, type ProjectView } from './state'
import { planSteps, type PlanStep } from './steps'
import type { SessionEvent } from './types'
import type { RecentProject } from '../projectSelection'
import type { SessionSummary } from '../types'

const POLL_MS = 2_000

export interface ProjectExperienceProps {
  workspace: string
  projectId: string
  projects: readonly RecentProject[]
  pinned: readonly string[]
  onTogglePin: (id: string) => void
  onOpenProject: (project: RecentProject) => void
  onNewProject: () => void
  sessions: readonly SessionSummary[]
  selectedSessionId: string | null
  onOpenSession: (workspace: string, id: string) => void
  onSettings: () => void
  models: ReadonlyArray<{ id: string; name: string }>
  model?: string | undefined
  reasoningEffort: 'default' | 'low' | 'medium' | 'high'
  onModel: (model: string) => Promise<void> | void
  onReasoningEffort: (effort: 'default' | 'low' | 'medium' | 'high') => Promise<void> | void
}

/**
 * Project 屏：三栏。左栏是应用级的侧边栏，中间是这个 Project 的持续对话，右侧是按需打开
 * 的 Thread 面板。
 *
 * 数据只来自三种投影：消息读 Box，Thread 读 Blackboard 的记录，Thread 的执行细节读那个
 * Agent 自己的 Session。界面上的步骤、状态、回复数都是这些投影算出来的，不从模型文本里猜。
 */
export function ProjectExperience(props: ProjectExperienceProps) {
  const { workspace, projectId } = props
  const [view, setView] = useState<ProjectView | null>(null)
  const [connection, setConnection] = useState<{ projectId: string; cursor: number } | null>(null)
  const [panel, setPanel] = useState<SidePanel>('overview')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [details, setDetails] = useState<ReadonlyMap<string, SessionEvent[]>>(new Map())
  const [loadingThread, setLoadingThread] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [threadDraft, setThreadDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selection = useRef<string | null>(null)

  useEffect(() => {
    selection.current = projectId
    setView(null)
    setConnection(null)
    setThreadId(null)
    setDetails(new Map())
    setPanel('overview')
    setError(null)
    void api
      .getProject(workspace, projectId)
      .then(snapshot => {
        if (selection.current !== projectId) return
        setView(fromSnapshot(snapshot))
        // 连接从这份快照的游标开始：之后的每一条都是新消息，之前的一条都不重放。
        setConnection({ projectId, cursor: snapshot.cursor })
      })
      .catch((reason: unknown) => {
        if (selection.current === projectId) setError(messageOf(reason))
      })
  }, [workspace, projectId])

  // 一条 SSE 连接：只在「打开的 Project 变了」时重连，不会因为新消息而抖。
  useEffect(() => {
    if (!connection) return
    const stop = api.streamProject(workspace, connection.projectId, {
      after: connection.cursor,
      onEvent: event => setView(current => (current ? applyStreamEvent(current, event) : current)),
      onError: reason => setError(messageOf(reason)),
    })
    return stop
  }, [workspace, connection])

  const loadThread = useCallback(
    async (id: string, quiet: boolean): Promise<void> => {
      if (!quiet) setLoadingThread(id)
      try {
        const detail = await api.getThread(workspace, projectId, id)
        setDetails(current => new Map(current).set(id, detail.events))
      } catch (reason) {
        if (!quiet) setError(messageOf(reason))
      } finally {
        if (!quiet) setLoadingThread(null)
      }
    },
    [workspace, projectId],
  )

  // 还没结束的 Thread 才需要跟着看：它们的步骤会变。结束的留在最后一次读到的地方。
  const liveIds = useMemo(
    () => (view?.threads ?? [])
      .filter(thread => thread.depth > 0 && thread.state !== 'done' && thread.state !== 'failed')
      .map(thread => thread.id)
      .sort(),
    [view?.threads],
  )
  const liveKey = liveIds.join(' ')

  useEffect(() => {
    for (const id of liveKey ? liveKey.split(' ') : []) {
      void loadThread(id, true)
    }
  }, [liveKey, loadThread])

  useEffect(() => {
    if (!liveKey) return
    const timer = setInterval(() => {
      for (const id of liveKey.split(' ')) void loadThread(id, true)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [liveKey, loadThread])

  useEffect(() => {
    if (!threadId) return
    void loadThread(threadId, false)
  }, [threadId, loadThread])

  const plans = useMemo(() => {
    const map = new Map<string, PlanStep[]>()
    for (const [id, events] of details) {
      const steps = planSteps(latestPlanFromEvents(events))
      if (steps.length) map.set(id, steps)
    }
    return map
  }, [details])

  const artifacts = view ? view.artifacts.length + view.resources.length : 0
  const thread = threadId ? view?.threads.find(entry => entry.id === threadId) : undefined

  const sendMain = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    setBusy(true)
    setError(null)
    try {
      const { messageId, createdAt } = await api.sendProjectMessage(workspace, projectId, text)
      // 发送成功的判据是信封落盘。先在本地画出来，流里那条会按 messageId 去重。
      setView(current => (current
        ? mergeMessage(current, {
          messageId,
          projectId,
          sender: { kind: 'user', id: 'user' },
          recipients: [{ kind: 'agent', id: current.coordinatorId }],
          placement: { kind: 'main' },
          kind: 'user-message',
          text,
          refs: [],
          createdAt,
        })
        : current))
      setDraft('')
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }, [draft, workspace, projectId])

  const sendThread = useCallback(async (): Promise<void> => {
    const text = threadDraft.trim()
    if (!text || !threadId) return
    setBusy(true)
    setError(null)
    try {
      await api.sendThreadMessage(workspace, projectId, threadId, text)
      setThreadDraft('')
      await loadThread(threadId, true)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }, [threadDraft, threadId, workspace, projectId, loadThread])

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    const snapshot = await api.getProject(workspace, projectId)
    if (selection.current === projectId) setView(fromSnapshot(snapshot))
  }, [workspace, projectId])

  const context = `${workspace}${thread ? ` · ${thread.permission}` : ''}`
  const config = {
    models: props.models,
    ...(props.model !== undefined ? { model: props.model } : {}),
    onModel: props.onModel,
    reasoningEffort: props.reasoningEffort,
    onReasoningEffort: props.onReasoningEffort,
  }

  return (
    <div className="project-shell">
      <GlobalSidebar
        projects={[...props.projects]}
        pinned={props.pinned}
        selectedProjectId={projectId}
        onOpenProject={props.onOpenProject}
        onTogglePin={props.onTogglePin}
        onNewProject={props.onNewProject}
        artifactCount={artifacts}
        onOpenArtifacts={() => { setThreadId(null); setPanel('library') }}
        threads={view?.threads ?? []}
        activeThreadId={threadId}
        onOpenThread={id => setThreadId(id)}
        chats={[...props.sessions]}
        selectedChatId={props.selectedSessionId}
        onOpenChat={props.onOpenSession}
        onSettings={props.onSettings}
      />

      {view ? (
        <MainWorkspace
          view={view}
          workspace={workspace}
          plans={plans}
          panel={panel}
          onPanel={entry => { setThreadId(null); setPanel(entry) }}
          onOpenThread={id => setThreadId(id)}
          composer={{
            value: draft,
            onChange: setDraft,
            onSubmit: () => void sendMain(),
            placeholder: 'Ask for something, or add to the work in flight.',
            busy,
            context,
            ...config,
          }}
        />
      ) : (
        <section className="main-workspace">
          <div className="workspace-scroll">
            <p className="stream-empty">
              {error ? `Could not open this project. ${error}` : 'Loading…'}
            </p>
          </div>
        </section>
      )}

      {threadId ? (
        <ThreadPanel
          {...(thread ? { thread } : {})}
          steps={plans.get(threadId) ?? []}
          events={details.get(threadId) ?? []}
          loading={loadingThread === threadId}
          onClose={() => setThreadId(null)}
          composer={{
            value: threadDraft,
            onChange: setThreadDraft,
            onSubmit: () => void sendThread(),
            placeholder: 'Tell this thread something, or ask where it is.',
            busy,
            context,
            ...config,
          }}
        />
      ) : (
        view && (
          <aside className="project-panel" aria-label={panel}>
            {panel === 'overview' && (
              <OverviewPanel view={view} onOpenThread={id => setThreadId(id)} />
            )}
            {panel === 'library' && <LibraryPanel view={view} />}
            {panel === 'memory' && (
              <MemoryPanel
                workspace={workspace}
                projectId={projectId}
                view={view}
                onChanged={() => void refreshSnapshot()}
              />
            )}
          </aside>
        )
      )}

      {error && view && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
    </div>
  )
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
