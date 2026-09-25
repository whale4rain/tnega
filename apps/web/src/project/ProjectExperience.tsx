import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, TextArea } from '@radix-ui/themes'
import { BookOpen, FileText, LayoutList, X } from 'lucide-react'
import * as api from './api'
import { LibraryPanel, MemoryPanel, OverviewPanel } from './SidePanels'
import { ThreadPanel } from './ThreadPanel'
import { Timeline } from './Timeline'
import {
  applyStreamEvent,
  fromSnapshot,
  mergeMessage,
  pendingCount,
  type ProjectView,
} from './state'
import type { BoxPlacement, ThreadRecord } from './types'

type SidePanel = 'overview' | 'library' | 'memory'

/**
 * Project 屏：中央是持续主对话，右侧默认是 Overview，打开某个 Thread 时换成它的面板。
 *
 * 它只读三种投影：消息读 Box（主对话）、Thread 读 Blackboard 的记录、Thread 详情读那个
 * Agent 的 Session。UI 不从模型文本里猜卡片是否存在、工作是否结束 —— 因此刷新页面之后，
 * 主对话里的卡片与 Thread 详情仍然一致。
 */
export function ProjectExperience({
  workspace,
  projectId,
}: {
  workspace: string
  projectId: string
}) {
  const [connection, setConnection] = useState<{ projectId: string; cursor: number } | null>(null)
  const [view, setView] = useState<ProjectView | null>(null)
  const [panel, setPanel] = useState<SidePanel>('overview')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const selection = useRef<string | null>(null)

  useEffect(() => {
    selection.current = projectId
    setView(null)
    setConnection(null)
    setThreadId(null)
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

  useEffect(() => {
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [view?.messages.length])

  const openThread = useCallback((id: string) => {
    setThreadId(id)
    setPanel('overview')
  }, [])

  async function submitDraft(): Promise<void> {
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
          placement: { kind: 'main' } satisfies BoxPlacement,
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
  }

  async function refresh(): Promise<void> {
    const snapshot = await api.getProject(workspace, projectId)
    if (selection.current !== projectId) return
    setView(fromSnapshot(snapshot))
  }

  function onThread(thread: ThreadRecord): void {
    setView(current => (current
      ? { ...current, threads: current.threads.map(entry => (entry.id === thread.id ? thread : entry)) }
      : current))
  }

  const project = view?.project
  const pending = view ? pendingCount(view) : 0
  const open = threadId && view ? view.threads.find(thread => thread.id === threadId) : undefined
  const panels: Array<{ id: SidePanel; label: string; icon?: typeof FileText }> = [
    { id: 'overview', label: 'Overview', icon: LayoutList },
    { id: 'library', label: 'Library', icon: FileText },
    { id: 'memory', label: 'Memory', icon: BookOpen },
  ]

  return (
    <div className="project-experience">
      <header className="project-header">
        <div className="project-header-main">
          <span className="project-name">{project?.name ?? 'Project'}</span>
          <span className="project-folder" title={workspace}>{workspace}</span>
          {project?.goal && <span className="project-goal">{project.goal}</span>}
          {pending > 0 && <Badge color="amber">{pending} waiting on you</Badge>}
        </div>
        <div className="project-header-actions">
          {panels.map(entry => (
            <Button
              key={entry.id}
              size="1"
              variant={!threadId && panel === entry.id ? 'solid' : 'soft'}
              onClick={() => { setThreadId(null); setPanel(entry.id) }}
            >
              {entry.icon && <entry.icon size={14} aria-hidden="true" />}
              {entry.label}
            </Button>
          ))}
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span className="marker">Error</span>
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>Close</button>
        </div>
      )}

      <div className="project-body">
        <div className="project-conversation">
          <div className="messages-viewport" ref={scroller}>
            {view ? (
              <Timeline
                envelopes={view.messages}
                threads={view.threads}
                onOpenThread={openThread}
              />
            ) : (
              <div className="project-empty">
                <p>{error ? 'Could not open this project.' : 'Loading…'}</p>
                {error && <p className="project-empty-hint">{error}</p>}
              </div>
            )}
          </div>
          <div className="project-composer">
            <TextArea
              value={draft}
              placeholder="Ask for something, or add to the work in flight."
              disabled={!view || busy}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void submitDraft()
                }
              }}
            />
            <Button onClick={() => void submitDraft()} disabled={!view || busy || !draft.trim()}>
              Send
            </Button>
          </div>
        </div>

        {threadId && view ? (
          <ThreadPanel
            workspace={workspace}
            projectId={projectId}
            threadId={threadId}
            state={open?.state ?? 'idle'}
            onClose={() => setThreadId(null)}
            onThread={onThread}
          />
        ) : (
          <aside className="project-panel" aria-label={panel}>
            <div className="project-panel-head">
              <span>{panels.find(entry => entry.id === panel)?.label}</span>
              <button type="button" className="icon-button" onClick={() => setPanel('overview')} hidden={panel === 'overview'}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            {view && panel === 'overview' && (
              <OverviewPanel view={view} onOpenThread={openThread} />
            )}
            {view && panel === 'library' && <LibraryPanel view={view} />}
            {view && panel === 'memory' && (
              <MemoryPanel
                workspace={workspace}
                projectId={projectId}
                view={view}
                onChanged={() => void refresh()}
              />
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
