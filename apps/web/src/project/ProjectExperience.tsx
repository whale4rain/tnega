import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { Badge } from '@radix-ui/themes'
import { ListTodo } from 'lucide-react'
import * as api from './api'
import { LibraryPanel, MemoryPanel, OverviewPanel } from './SidePanels'
import { ThreadPanel } from './ThreadPanel'
import { ComposerFrame } from '../workbench/ComposerFrame'
import {
  MessageBlock,
  PlanPanel,
  latestPlanFromEvents,
  projectEvents,
  type DisplayMessage,
  type DisplayPlan,
} from './reuse'
import { groupToolMessages } from '../toolGroups'
import { ToolGroupBlock } from '../conversation/Transcript'
import {
  applyStreamEvent,
  fromSnapshot,
  mergeMessage,
  threadReplies,
  threadStateLabel,
  type ProjectView,
} from './state'
import type { BootEnvelope, SessionEvent, ThreadState } from './types'

const POLL_MS = 2_000

export interface ProjectExperienceProps {
  workspace: string
  projectId: string
  models: ReadonlyArray<{
    id: string
    name: string
    reasoningEfforts: Array<'low' | 'medium' | 'high'>
  }>
  model?: string | undefined
  reasoningEffort: 'default' | 'low' | 'medium' | 'high'
  onModel: (model: string) => Promise<void> | void
  onReasoningEffort: (effort: 'default' | 'low' | 'medium' | 'high') => Promise<void> | void
  apiKeySet: boolean
  onSettings: () => void
}

/**
 * Project 屏：用的就是会话屏那套组件 —— `ComposerFrame` 输入区、`MessageBlock` 消息、
 * `PlanPanel` 计划卡，布局也是 `.chat` / `.chat-content` / `.messages-viewport` /
 * `.conversation-scroll` / `.composer-surface`。它自己只加了「线程卡片」与右侧执行栏。
 *
 * 两种投影：主对话的消息来自 Box，Thread 的执行细节来自那个 Agent 自己的 Session。
 */
export function ProjectExperience(props: ProjectExperienceProps) {
  const { workspace, projectId } = props
  const [view, setView] = useState<ProjectView | null>(null)
  const [connection, setConnection] = useState<{ projectId: string; cursor: number } | null>(null)
  const [panel, setPanel] = useState<'overview' | 'library' | 'memory' | null>(null)
  const [threadId, setThreadId] = useState<string | null>(null)
  const [details, setDetails] = useState<ReadonlyMap<string, SessionEvent[]>>(new Map())
  const [loadingThread, setLoadingThread] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [threadDraft, setThreadDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<'connecting' | 'live' | 'retrying'>('connecting')
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = Number(localStorage.getItem('tnega-project-panel-width'))
    const max = Math.max(260, Math.min(720, window.innerWidth - 380))
    return Math.max(260, Math.min(max, Number.isFinite(stored) && stored >= 260 ? stored : 380))
  })
  const panelDragging = useRef(false)
  const panelRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const selection = useRef<string | null>(null)
  // 正在生成的正文：按 Agent 攒起来，等整轮的回复发布出来就丢掉。逐块重渲染太碎，
  // 攒到下一帧再画。
  const drafts = useRef(new Map<string, string>())
  const [rendered, setRendered] = useState<ReadonlyMap<string, string>>(new Map())
  const coordinatorEvents = details.get(view?.coordinatorId ?? '') ?? []
  const activityItems = useMemo(() => {
    const lastTurnStart = [...coordinatorEvents].reverse().find(event => event.type === 'turn/start')?.seq ?? 0
    const turnEvents = coordinatorEvents.filter(event => event.seq >= lastTurnStart)
    const visible: DisplayMessage[] = projectEvents(turnEvents)
      .filter(message => message.role === 'tool' || message.role === 'subagent')
    return groupToolMessages(visible)
  }, [coordinatorEvents])
  const inboxCards = useMemo(() => {
    const cards = new Map<string, DisplayMessage>()
    for (const envelope of view?.inboxMessages ?? []) {
      if (envelope.sender.kind !== 'agent' || envelope.sender.id === view?.coordinatorId) continue
      const thread = view?.threads.find(item => item.id === envelope.sender.id)
      let card = cards.get(envelope.sender.id)
      if (!card) {
        card = {
          id: `inbox-${envelope.sender.id}`,
          role: 'subagent',
          content: '',
          subagent: {
            id: envelope.sender.id,
            label: thread?.label ?? 'Subagent',
            task: thread?.goal ?? '',
            mode: 'spawn',
            status: 'running',
            replies: [],
          },
        }
        cards.set(envelope.sender.id, card)
      }
      card.subagent?.replies.push(envelope.text)
      if (card.subagent) {
        card.subagent.status = envelope.kind === 'complete' ? 'ready'
          : envelope.kind === 'failed' ? 'failed'
            : envelope.kind === 'blocked' || envelope.kind === 'request' ? 'idle' : 'running'
      }
    }
    return [...cards.values()]
  }, [view])
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleFlush = useCallback(() => {
    if (flush.current) return
    flush.current = setTimeout(() => {
      flush.current = null
      setRendered(new Map(drafts.current))
    }, 16)
  }, [])
  function resizePanel(event: PointerEvent<HTMLDivElement>) {
    if (!panelDragging.current) return
    const right = panelRef.current?.getBoundingClientRect().right
    if (right === undefined) return
    const max = Math.max(260, Math.min(720, window.innerWidth - 380))
    setPanelWidth(Math.max(260, Math.min(max, right - event.clientX)))
  }
  function stopPanelResize(event: PointerEvent<HTMLDivElement>) {
    if (!panelDragging.current) return
    panelDragging.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    localStorage.setItem('tnega-project-panel-width', String(panelWidth))
  }
  const clearDraft = useCallback((agentId: string) => {
    if (!drafts.current.delete(agentId)) return
    scheduleFlush()
  }, [scheduleFlush])

  useEffect(() => {
    selection.current = projectId
    setView(null)
    setConnection(null)
    setThreadId(null)
    setDetails(new Map())
    setPanel(null)
    setError(null)
    setLive('connecting')
    drafts.current.clear()
    scheduleFlush()
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

  // 一条 SSE 连接：只在「打开的 Project 变了」时重连；断了自己按游标接回来（服务重启、
  // 网络抖动、后台标签页被节流都会断，断了不接就只能靠刷新）。
  const cursorRef = useRef(0)
  useEffect(() => {
    if (connection) cursorRef.current = connection.cursor
  }, [connection])
  useEffect(() => {
    if (!connection) return
    let stopped = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let stop: (() => void) | undefined
    const connect = (): void => {
      stop = api.streamProject(workspace, connection.projectId, {
        after: cursorRef.current,
        onOpen: () => setLive('live'),
        onEvent: event => {
          attempt = 0
          if (event.type === 'chunk') {
            drafts.current.set(event.agentId, (drafts.current.get(event.agentId) ?? '') + event.text)
            scheduleFlush()
            return
          }
          if (event.type === 'agent-status') {
            // 开始跑就先占一个位置（还没有正文时也看得见「它在工作」），跑完就交还给
            // 那条已经发布的回复。
            if (event.status === 'running') {
              if (!drafts.current.has(event.agentId)) {
                drafts.current.set(event.agentId, '')
                scheduleFlush()
              }
            } else if (!drafts.current.get(event.agentId)) {
              clearDraft(event.agentId)
            }
            return
          }
          if (event.type === 'message') {
            cursorRef.current = Math.max(cursorRef.current, event.seq)
            if (event.envelope.sender.kind === 'agent') {
              clearDraft(event.envelope.sender.id)
            }
          }
          setView(current => (current ? applyStreamEvent(current, event) : current))
        },
        onError: reason => setError(messageOf(reason)),
        onClose: () => {
          if (stopped) return
          setLive('retrying')
          const delay = Math.min(1_000 * 2 ** attempt, 10_000)
          attempt += 1
          timer = setTimeout(connect, delay)
        },
      })
    }
    connect()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      stop?.()
    }
  }, [workspace, connection, scheduleFlush, clearDraft])

  useEffect(() => () => {
    if (flush.current) clearTimeout(flush.current)
  }, [])

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
  const liveKey = (view?.threads ?? [])
    .filter(thread => (thread.depth > 0 || thread.id === view?.coordinatorId)
      && thread.state !== 'done' && thread.state !== 'failed'
      && (thread.depth > 0 || thread.state === 'working'))
    .map(thread => thread.id)
    .sort()
    .join(' ')

  useEffect(() => {
    for (const id of liveKey ? liveKey.split(' ') : []) void loadThread(id, true)
  }, [liveKey, loadThread])

  useEffect(() => {
    if (!liveKey) return
    const timer = setInterval(() => {
      for (const id of liveKey.split(' ')) void loadThread(id, true)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [liveKey, loadThread])

  useEffect(() => {
    if (threadId) void loadThread(threadId, false)
  }, [threadId, loadThread])

  useEffect(() => {
    if (view?.coordinatorId) void loadThread(view.coordinatorId, true)
  }, [view?.coordinatorId, loadThread])

  const plans = useMemo(() => {
    const map = new Map<string, DisplayPlan>()
    for (const [id, events] of details) {
      const plan = latestPlanFromEvents(events)
      if (plan) map.set(id, plan)
    }
    return map
  }, [details])

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [view?.messages.length])

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

  const thread = threadId ? view?.threads.find(entry => entry.id === threadId) : undefined
  const coordinator = view?.threads.find(entry => entry.id === view.coordinatorId)
  const tasks = (view?.threads ?? []).filter(entry => entry.depth > 0)
  const waiting = tasks.filter(entry => entry.state === 'waiting' || entry.state === 'blocked')
  const composer = {
    workspace,
    models: [...props.models],
    ...(props.model !== undefined ? { model: props.model } : {}),
    reasoningEffort: props.reasoningEffort,
    onModel: async (model: string) => { await props.onModel(model) },
    onReasoningEffort: async (effort: 'default' | 'low' | 'medium' | 'high') => {
      await props.onReasoningEffort(effort)
    },
    apiKeySet: props.apiKeySet,
    onSettings: props.onSettings,
  }

  return (
    <div className="chat">
      <div className="chat-content">
        <div className="chat-header">
          <div className="chat-title-line">
            <div className="chat-title ellipsis" title={workspace}>
              {view?.project.name ?? 'Project'}
            </div>
            <span className="agent-badge general">project</span>
          </div>
          <div className="chat-meta">
            <span className="ellipsis" title={workspace}>{workspace}</span>
            {view?.project.goal && <span className="ellipsis">{view.project.goal}</span>}
            <span className="stream-state" data-state={live} title={
              live === 'live' ? 'Following this project live' : 'Reconnecting to this project'
            }>
              {live === 'live' ? 'live' : 'reconnecting…'}
            </span>
          </div>
          <div className="chat-header-actions">
            {!!waiting.length && <Badge color="amber">{waiting.length} waiting on you</Badge>}
            {(['overview', 'library', 'memory'] as const).map(entry => (
              <button
                key={entry}
                type="button"
                aria-pressed={!threadId && panel === entry}
                onClick={() => {
                  setThreadId(null)
                  setPanel(current => (current === entry ? null : entry))
                }}
              >
                {entry}
              </button>
            ))}
          </div>
        </div>

        <div className="messages-viewport">
          <div className="conversation-scroll" ref={scrollRef}>
            <div className="messages">
              {view?.messages.map(envelope => {
                const target = envelope.threadId
                  ? view.threads.find(entry => entry.id === envelope.threadId)
                  : undefined
                return (
                  <ProjectMessage
                    key={envelope.messageId}
                    envelope={envelope}
                    label={target?.label}
                    state={target?.state}
                    plan={envelope.threadId ? plans.get(envelope.threadId) : undefined}
                    replies={envelope.threadId
                      ? threadReplies(view.messages, envelope.threadId).length
                      : 0}
                    onOpenThread={id => setThreadId(id)}
                  />
                )
              })}
              {view && rendered.has(view.coordinatorId) && (
                <MessageBlock
                  message={{
                    id: 'draft',
                    role: 'assistant',
                    content: rendered.get(view.coordinatorId) ?? '',
                    pending: true,
                  }}
                />
              )}
              {activityItems.map(item => item.kind === 'tools'
                ? <ToolGroupBlock key={`coordinator-tools-${item.tools[0]?.id ?? 'empty'}`} tools={item.tools} />
                : item.message.role === 'subagent'
                  ? <MessageBlock key={item.message.id} message={item.message} />
                  : <MessageBlock key={item.message.id} message={item.message} assistantLabel="Inbox" />
              )}
              {inboxCards.map(message => (
                <MessageBlock
                  key={message.id}
                  message={message}
                  onOpenSubagent={id => setThreadId(id)}
                />
              ))}
              {view && !view.messages.length && (
                <div className="conversation-welcome">
                  <ListTodo size={28} strokeWidth={1.4} />
                  <h2>What should this project work on?</h2>
                  <p>Ask something small, or describe work worth its own thread.</p>
                </div>
              )}
              {!view && (
                <div className="conversation-welcome">
                  <h2>{error ? 'Could not open this project' : 'Loading…'}</h2>
                  {error && <p>{error}</p>}
                </div>
              )}
            </div>

            <div className="composer-surface">
              <ComposerFrame
                {...composer}
                permission={coordinator?.permission ?? 'read-only'}
                disabled={!view || busy}
                value={draft}
                onChange={setDraft}
                onSubmit={() => void sendMain()}
                canSend={!!draft.trim() && !busy}
                placeholder="Ask for something, or add to the work in flight."
              />
              <div className="conversation-footer">
                <button
                  type="button"
                  className={`subagent-toggle${threadId ? ' active' : ''}`}
                  aria-expanded={threadId !== null}
                  disabled={!tasks.length}
                  onClick={() => setThreadId(current => (current ? null : tasks[0]?.id ?? null))}
                >
                  <ListTodo size={14} aria-hidden="true" />
                  {tasks.filter(entry => entry.state === 'working').length} active task
                  {tasks.length > 0 && <span className="subagent-total">· {tasks.length} total</span>}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {threadId ? (
        <ThreadPanel
          {...(thread ? { thread } : {})}
          events={details.get(threadId) ?? []}
          loading={loadingThread === threadId}
          {...(rendered.has(threadId) ? { draft: rendered.get(threadId) ?? '' } : {})}
          onClose={() => setThreadId(null)}
          composer={
            <div className="composer-surface">
              <ComposerFrame
                {...composer}
                permission={thread?.permission ?? 'read-only'}
                disabled={busy}
                accessory={<PlanPanel plan={plans.get(threadId)} />}
                value={threadDraft}
                onChange={setThreadDraft}
                onSubmit={() => void sendThread()}
                canSend={!!threadDraft.trim() && !busy}
                placeholder="Tell this thread something, or ask where it is."
              />
            </div>
          }
        />
      ) : (
        view && panel && (
          <aside ref={panelRef} className="project-panel" aria-label={panel} style={{ flexBasis: panelWidth }}>
            <div className="project-panel-resize-handle" role="separator" aria-label="Resize project panel"
              aria-orientation="vertical" aria-valuenow={panelWidth} tabIndex={0}
              onPointerDown={event => { panelDragging.current = true; event.currentTarget.setPointerCapture(event.pointerId) }}
              onPointerMove={resizePanel} onPointerUp={stopPanelResize} onPointerCancel={stopPanelResize}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const next = Math.max(260, Math.min(720, panelWidth + (event.key === 'ArrowLeft' ? 24 : -24)))
                setPanelWidth(next)
                localStorage.setItem('tnega-project-panel-width', String(next))
              }} />
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
      {view && error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
    </div>
  )
}

/** 主对话里的一条：普通发言走会话屏的 MessageBlock，派工是一张线程卡片。 */
function ProjectMessage({
  envelope,
  label,
  state,
  plan,
  replies,
  onOpenThread,
}: {
  envelope: BootEnvelope
  label?: string | undefined
  state?: ThreadState | undefined
  plan?: DisplayPlan | undefined
  replies: number
  onOpenThread: (id: string) => void
}) {
  if (envelope.kind === 'dispatch') {
    const target = envelope.threadId ?? ''
    return (
      <div className="thread-card" data-state={state ?? 'idle'}>
        <div className="thread-card-head">
          <span className="thread-card-title">{label ?? 'Thread'}</span>
          <span className="thread-card-state">
            {state ? threadStateLabel(state) : 'starting'}
          </span>
        </div>
        <PlanPanel plan={plan} />
        <button
          type="button"
          className="thread-card-open"
          disabled={!target}
          onClick={() => onOpenThread(target)}
        >
          {replies === 1 ? '1 reply' : `${replies} replies`}
        </button>
      </div>
    )
  }

  if (envelope.kind === 'notice') {
    return (
      <div className="message system">
        <div className="message-body">{envelope.text}</div>
      </div>
    )
  }

  return (
    <MessageBlock
      message={{
        id: envelope.messageId,
        role: envelope.sender.kind === 'user' ? 'user' : 'assistant',
        content: envelope.text,
      }}
      assistantLabel={label ?? 'Tnega'}
    />
  )
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
