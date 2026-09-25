import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, TextArea, TextField } from '@radix-ui/themes'
import { BookOpen, FileText, LayoutList, Plus } from 'lucide-react'
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
import type { BoxPlacement, ProjectRecord, ThreadRecord } from './types'

type SidePanel = 'overview' | 'library' | 'memory'

const LAST_PROJECT_KEY = 'tnega-project'

function placementKey(projectId: string): string {
  return `${LAST_PROJECT_KEY}:${projectId}`
}

/**
 * Project 屏：中央是持续主对话，右侧按需打开 Thread 或状态面板。
 *
 * 它只读三种投影：消息读 Box（主对话）、Thread 读 Blackboard 的记录、Thread 详情读那个
 * Agent 的 Session。UI 不从模型文本里猜卡片是否存在、工作是否结束 —— 因此刷新页面之后，
 * 主对话里的卡片与 Thread 详情仍然一致。
 */
export function ProjectExperience({ workspace }: { workspace: string }) {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  /** 当前跟随的连接：打开的 Project 与它快照里的游标。 */
  const [connection, setConnection] = useState<{ projectId: string; cursor: number } | null>(null)
  const [view, setView] = useState<ProjectView | null>(null)
  const [panel, setPanel] = useState<SidePanel | null>(null)
  const [threadId, setThreadId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const selection = useRef<string | null>(null)

  const open = useCallback(
    async (id: string) => {
      selection.current = id
      setProjectId(id)
      setView(null)
      setConnection(null)
      setThreadId(null)
      setPanel(null)
      try {
        const snapshot = await api.getProject(workspace, id)
        if (selection.current !== id) return
        setView(fromSnapshot(snapshot))
        // 连接从这份快照的游标开始：之后的每一条都是新消息，之前的一条都不重放。
        setConnection({ projectId: id, cursor: snapshot.cursor })
        localStorage.setItem(placementKey(workspace), id)
      } catch (reason) {
        if (selection.current === id) setError(messageOf(reason))
      }
    },
    [workspace],
  )

  useEffect(() => {
    let cancelled = false
    selection.current = null
    setView(null)
    setProjectId(null)
    setProjects([])
    void api
      .listProjects(workspace)
      .then(({ projects: next }) => {
        if (cancelled) return
        setProjects(next)
        const remembered = localStorage.getItem(placementKey(workspace))
        const target = next.find(entry => entry.id === remembered) ?? next.at(-1)
        if (target) void open(target.id)
        else setCreating(true)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageOf(reason))
      })
    return () => {
      cancelled = true
    }
  }, [workspace, open])

  // 一条 SSE 连接：从打开这份快照时的游标开始跟随。切换 Project 会换一个连接描述，
  // 因此这里只在「打开的 Project 变了」时重连，不会因为新消息而抖。
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

  const refresh = useCallback(async () => {
    if (!projectId) return
    const snapshot = await api.getProject(workspace, projectId)
    if (selection.current !== projectId) return
    setView(fromSnapshot(snapshot))
  }, [workspace, projectId])

  async function submitDraft(): Promise<void> {
    const text = draft.trim()
    if (!text || !projectId) return
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

  async function create(): Promise<void> {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const { project } = await api.createProject(workspace, {
        name: name.trim(),
        ...(goal.trim() ? { goal: goal.trim() } : {}),
      })
      setProjects(current => [...current, project])
      setName('')
      setGoal('')
      setCreating(false)
      await open(project.id)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  function onThread(thread: ThreadRecord): void {
    setView(current => (current
      ? { ...current, threads: current.threads.map(entry => (entry.id === thread.id ? thread : entry)) }
      : current))
  }

  const project = view?.project
  const pending = view ? pendingCount(view) : 0

  return (
    <div className="project-experience">
      <header className="project-header">
        <div className="project-header-main">
          <LayoutList size={16} aria-hidden="true" />
          {projects.length > 1 ? (
            <select
              className="project-picker"
              value={projectId ?? ''}
              onChange={event => void open(event.target.value)}
              aria-label="Project"
            >
              {projects.map(entry => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          ) : (
            <span className="project-name">{project?.name ?? 'Project'}</span>
          )}
          {project?.goal && <span className="project-goal">{project.goal}</span>}
          {pending > 0 && <Badge color="amber">{pending} waiting on you</Badge>}
        </div>
        <div className="project-header-actions">
          <Button
            size="1"
            variant={panel === 'overview' ? 'solid' : 'soft'}
            onClick={() => { setPanel(panel === 'overview' ? null : 'overview'); setThreadId(null) }}
          >
            Overview
          </Button>
          <Button
            size="1"
            variant={panel === 'library' ? 'solid' : 'soft'}
            onClick={() => { setPanel(panel === 'library' ? null : 'library'); setThreadId(null) }}
          >
            <FileText size={14} aria-hidden="true" />
            Library
          </Button>
          <Button
            size="1"
            variant={panel === 'memory' ? 'solid' : 'soft'}
            onClick={() => { setPanel(panel === 'memory' ? null : 'memory'); setThreadId(null) }}
          >
            <BookOpen size={14} aria-hidden="true" />
            Memory
          </Button>
          <Button size="1" variant="soft" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden="true" />
            New
          </Button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span className="marker">Error</span>
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>Close</button>
        </div>
      )}

      {creating && (
        <div className="project-create">
          <TextField.Root
            size="2"
            placeholder="Project name"
            value={name}
            onChange={event => setName(event.target.value)}
            autoFocus
          />
          <TextField.Root
            size="2"
            placeholder="What is it for? (optional)"
            value={goal}
            onChange={event => setGoal(event.target.value)}
          />
          <div className="project-create-actions">
            <Button size="2" onClick={() => void create()} disabled={busy || !name.trim()}>Create</Button>
            {!!projects.length && (
              <Button size="2" variant="soft" onClick={() => setCreating(false)}>Cancel</Button>
            )}
          </div>
        </div>
      )}

      <div className="project-body">
        <div className="project-conversation">
          <div className="messages-viewport" ref={scroller}>
            {view ? (
              <Timeline
                envelopes={view.messages}
                threads={view.threads}
                onOpenThread={id => { setPanel(null); setThreadId(id) }}
              />
            ) : (
              <div className="project-empty"><p>Loading…</p></div>
            )}
          </div>
          <div className="project-composer">
            <TextArea
              value={draft}
              placeholder="Ask for something, or add to the work in flight."
              disabled={!projectId || busy}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void submitDraft()
                }
              }}
            />
            <Button onClick={() => void submitDraft()} disabled={!projectId || busy || !draft.trim()}>
              Send
            </Button>
          </div>
        </div>

        {threadId && (
          <ThreadPanel
            workspace={workspace}
            projectId={projectId!}
            threadId={threadId}
            onClose={() => setThreadId(null)}
            onThread={onThread}
          />
        )}
        {!threadId && panel && view && (
          <aside className="project-panel" aria-label={panel}>
            {panel === 'overview' && (
              <OverviewPanel
                view={view}
                onOpenThread={id => { setPanel(null); setThreadId(id) }}
              />
            )}
            {panel === 'library' && <LibraryPanel view={view} />}
            {panel === 'memory' && (
              <MemoryPanel
                workspace={workspace}
                projectId={projectId!}
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
