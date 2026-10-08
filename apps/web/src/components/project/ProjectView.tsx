import {
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  Pause,
  Settings2,
  WifiOff,
  CornerUpLeft,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { avatarVersion, distinctSeeds, subscribeAvatars } from '../../lib/avatar'
import { errorText } from '../../lib/hooks'
import { followProject, isUnsupported, localReplies, projectApi } from '../../lib/project-api'
import { notifyDesktopThread } from '../../lib/desktop-completion'
import {
  activeCount,
  agentLabel,
  artifactsFor,
  board,
  fromSnapshot,
  mainTimeline,
  plainPreview,
  reduceProject,
  threadState,
  workerThreads,
  type MainItem,
  type ProjectState,
  type ReplyRef,
} from '../../lib/project-model'
import type { ProjectStreamEvent } from '../../lib/project-types'
import type { ConfigSnapshot } from '../../lib/types'
import { LinkContext, type LinkHandlers } from '../../lib/links'
import { navigateBrowser } from '../../lib/browser-live'
import { BOARD_KEY, closeDoc, openDoc, openTool, select, toggle, type WorkbenchState } from '../../lib/workbench'
import type { WorkbenchProject } from '../workbench/Workbench'
import { AgentAvatar, AvatarSeeds } from '../AgentAvatar'
import { PromptBox } from '../Composer'
import { ApprovalCard } from '../Conversation'
import { BackgroundJobs } from '../BackgroundJobs'
import { Markdown } from '../Markdown'
import { Menu } from '../Menu'
import { ArtifactCards } from './Artifacts'
import { BoardPanel } from './Board'
import { LibraryPanel, SettingsPanel } from './ProjectPanels'
import { RoutinesPanel } from './Routines'
import { ExchangePanel } from './ExchangePanel'
import { ThreadPanel } from './ThreadPanel'
import { ChatRun as Run } from './ChatRun'

/**
 * A project screen: the room on the left, and the project's own tabs (Board,
 * Library, Routines, opened threads, settings) in the same Workbench a
 * session uses. The tabs render here and are portalled into the Workbench's
 * project slot, so they share this view's state and live stream.
 */
export function ProjectView({
  workspace,
  projectId,
  threadId,
  config,
  onConfigChanged,
  onOpenThread,
  onDeleted,
  onChanged,
  sidebarOpen,
  onToggleSidebar,
  workbench,
  onWorkbench,
  panelSlot,
  onPanelTabs,
}: {
  workspace: string
  projectId: string
  threadId: string | undefined
  config: ConfigSnapshot | undefined
  onConfigChanged?: ((config: ConfigSnapshot) => void) | undefined
  onOpenThread: (threadId: string | undefined) => void
  onDeleted: () => void
  onChanged: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
  workbench: WorkbenchState
  onWorkbench: (update: (state: WorkbenchState) => WorkbenchState) => void
  panelSlot: HTMLDivElement | null
  onPanelTabs: (tabs: WorkbenchProject['tabs']) => void
}) {
  const [state, setState] = useState<ProjectState | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [connected, setConnected] = useState(true)
  const [notice, setNotice] = useState<string | undefined>()
  const [replyTarget, setReplyTarget] = useState<ReplyRef | undefined>()
  const [seen, markSeen] = useSeenThreads(projectId)
  const links = useMemo<LinkHandlers>(() => ({
    workspace,
    openPath: path => onWorkbench(current => /\.(?:docx|xlsx|pptx|pdf|png|jpe?g|webp|gif|svg)$/i.test(path)
      ? openDoc(current, { kind: 'preview', path }) : openTool(current, 'files', path)),
    openLocalUrl: url => {
      onWorkbench(current => openTool(current, 'browser'))
      void navigateBrowser(url).catch(reason => setError(errorText(reason)))
    },
  }), [workspace, onWorkbench])

  // Snapshot first, then follow the change stream from its cursor.
  useEffect(() => {
    setState(undefined)
    setError(undefined)
    let stop: (() => void) | undefined
    let cancelled = false
    const queue: ProjectStreamEvent[] = []
    let frame: number | undefined
    const flush = () => {
      frame = undefined
      const events = queue.splice(0)
      if (events.length) setState(current => current && events.reduce(reduceProject, current))
    }
    projectApi.snapshot(workspace, projectId).then(snapshot => {
      if (cancelled) return
      setState(fromSnapshot(snapshot, localReplies(projectId)))
      stop = followProject(workspace, projectId, snapshot.cursor, event => {
        queue.push(event)
        frame ??= requestAnimationFrame(flush)
      }, setConnected)
    }, reason => !cancelled && setError(errorText(reason)))
    return () => {
      cancelled = true
      stop?.()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [workspace, projectId])

  // Keep the sidebar list fresh when the project's name or archive state changes.
  const name = state?.project.name
  const archived = state?.project.archived
  useEffect(() => {
    if (name !== undefined) onChanged()
  }, [name, archived, onChanged])

  /** Open a thread as a Workbench tab, and remember it in the address. */
  const openThread = useCallback((id: string) => {
    const label = state?.threads[id]?.label ?? 'Thread'
    onWorkbench(current => openDoc(current, { kind: 'thread', id, label }))
    onOpenThread(id)
  }, [state?.threads, onWorkbench, onOpenThread])

  const openExchange = (firstId: string, secondId: string) => {
    if (!state) return
    onWorkbench(current => openDoc(current, { kind: 'exchange', firstId, secondId,
      label: `${agentLabel(state, firstId)} ↔ ${agentLabel(state, secondId)}` }))
  }

  // A thread named in the address (a link, a reload) opens once the project has loaded.
  const loaded = Boolean(state)
  const routed = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!loaded || !threadId || routed.current === threadId) return
    routed.current = threadId
    openThread(threadId)
  }, [loaded, threadId, openThread])

  // The thread whose tab is showing counts as read.
  const shownThreadId = workbench.open && workbench.active.startsWith('thread:') ? workbench.active.slice('thread:'.length) : undefined
  const shownThread = shownThreadId && state ? state.threads[shownThreadId] : undefined
  useEffect(() => {
    if (shownThread) markSeen(shownThread.id, shownThread.updatedAt)
  }, [shownThread, markSeen])

  // A thread that finishes, fails or needs a decision notifies the user once.
  const settled = useRef<Record<string, string> | undefined>(undefined)
  useEffect(() => {
    if (!state) return
    const now: Record<string, string> = {}
    for (const thread of workerThreads(state)) now[thread.id] = threadState(state, thread)
    const before = settled.current
    settled.current = now
    if (!before) return
    for (const [id, current] of Object.entries(now)) {
      if (before[id] === current || id === shownThreadId) continue
      const key = `${id}:${state.threads[id]?.updatedAt ?? 0}`
      if (current === 'done') notifyDesktopThread(key, 'completed')
      else if (current === 'failed') notifyDesktopThread(key, 'failed')
      else if (current === 'waiting' || current === 'blocked') notifyDesktopThread(key, 'waiting')
    }
  }, [state, shownThreadId])

  // The Board tab carries a count: what needs you, else what is working.
  const columns = useMemo(() => (state ? board(state, seen) : []), [state, seen])
  const needs = columns.find(column => column.key === 'needs')?.threads.length ?? 0
  const live = columns.find(column => column.key === 'working')?.threads.length ?? 0
  const routineCount = state?.routines.filter(routine => routine.data.enabled).length ?? 0
  useEffect(() => {
    onPanelTabs([
      { tab: 'board', badge: needs || live, attention: needs > 0 },
      { tab: 'library' },
      { tab: 'routines', badge: routineCount },
    ])
  }, [needs, live, routineCount, onPanelTabs])

  const items = useMemo(() => (state ? mainTimeline(state) : []), [state])
  const coordinatorRunning = state ? Boolean(state.running[state.coordinatorId]) : false
  const messageTargetId = replyTarget?.who === 'thread' && replyTarget.threadId
    ? replyTarget.threadId : state?.coordinatorId
  const messageTargetRunning = Boolean(messageTargetId && state?.running[messageTargetId])

  // Give every agent in the project its own look, coordinator first.
  const avatarsVersion = useSyncExternalStore(subscribeAvatars, avatarVersion, () => 0)
  const agentOrder = state
    ? [state.coordinatorId, ...workerThreads(state).map(thread => thread.id)].join(',')
    : ''
  const seeds = useMemo(
    () => distinctSeeds(agentOrder ? agentOrder.split(',') : [], state?.coordinatorId),
    // `avatarsVersion` invalidates the seeds after a reroll.
    [agentOrder, avatarsVersion],
  )

  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [items, state?.approvals])

  const send = useCallback(async (text: string, interrupt = false) => {
    // Replying to a thread card is a direct message to that thread.
    if (replyTarget?.who === 'thread' && replyTarget.threadId) {
      try {
        await projectApi.sendToThread(workspace, projectId, replyTarget.threadId, text, interrupt)
        setReplyTarget(undefined)
        openThread(replyTarget.threadId)
        return true
      } catch (reason) {
        setError(errorText(reason))
        return false
      }
    }
    const replyTo = replyTarget?.id
    try {
      const receipt = await projectApi.send(workspace, projectId, text, replyTo, interrupt)
      // Show the message immediately; the stream will confirm the same envelope.
      setState(current => current && reduceProject(current, {
        type: 'message',
        seq: current.cursor,
        envelope: {
          messageId: receipt.messageId,
          projectId,
          sender: { kind: 'user', id: 'user' },
          recipients: [{ kind: 'agent', id: current.coordinatorId }],
          placement: { kind: 'main' },
          kind: 'user-message',
          text,
          refs: [],
          ...(replyTo ? { causationId: replyTo } : {}),
          ...(interrupt ? { interrupt: true } : {}),
          createdAt: receipt.createdAt,
        },
      }))
      pinned.current = true
      setReplyTarget(undefined)
      return true
    } catch (reason) {
      setError(errorText(reason))
      return false
    }
  }, [workspace, projectId, replyTarget, openThread])

  const stopMessageTarget = async () => {
    if (!messageTargetId) return
    try {
      await projectApi.stopThread(workspace, projectId, messageTargetId)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  /** Scroll to a message in the conversation, or open the thread it came from. */
  const jump = useCallback((ref: ReplyRef) => {
    const target = ref.inMain ? document.getElementById(`msg-${ref.id}`) : null
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.classList.remove('flash')
      void target.offsetWidth
      target.classList.add('flash')
    } else if (ref.threadId) {
      openThread(ref.threadId)
    }
  }, [openThread])

  const answer = async (approvalId: string, allow: boolean) => {
    setState(current => current && { ...current, approvals: current.approvals.filter(a => a.id !== approvalId) })
    try {
      await projectApi.approve(workspace, projectId, approvalId, allow)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const pause = async () => {
    try {
      const result = await projectApi.pause(workspace, projectId)
      setNotice(`Paused ${result.stopped} running agent${result.stopped === 1 ? '' : 's'}.`)
    } catch (reason) {
      setNotice(isUnsupported(reason) ? 'Pausing a project is not supported by this server yet.' : errorText(reason))
    }
  }

  if (error && !state) {
    return (
      <main className="conversation">
        <div className="welcome"><p>{error}</p></div>
      </main>
    )
  }

  if (!state) {
    return (
      <main className="conversation">
        <div className="conv-column"><div className="skeleton"><div className="skeleton-line right w40" /><div className="skeleton-line w90" /><div className="skeleton-line w60" /></div></div>
      </main>
    )
  }

  const working = activeCount(state)
  const active = workbench.active
  const activeDoc = workbench.docs.find(doc => doc.key === active)
  const panel = !panelSlot ? null : active === BOARD_KEY
    ? <BoardPanel workspace={workspace} state={state} seen={seen} onOpenThread={openThread} />
    : active === 'project:library'
      ? <LibraryPanel workspace={workspace} state={state} />
      : active === 'project:routines'
        ? <RoutinesPanel workspace={workspace} state={state} onOpenThread={openThread} />
        : active === 'project-settings'
          ? <SettingsPanel key={state.project.id} workspace={workspace} state={state} config={config} onConfigChanged={onConfigChanged} onDeleted={onDeleted} />
          : activeDoc?.kind === 'exchange'
            ? <ExchangePanel workspace={workspace} state={state} firstId={activeDoc.firstId} secondId={activeDoc.secondId}
                onOpenThread={openThread} onClose={() => onWorkbench(current => closeDoc(current, active, BOARD_KEY))} />
          : shownThreadId
            ? <ThreadPanel key={shownThreadId} workspace={workspace} state={state} threadId={shownThreadId} onBack={() => onWorkbench(current => select(current, BOARD_KEY))} />
            : null

  return (
    <AvatarSeeds.Provider value={seeds}>
      <LinkContext.Provider value={links}>
      <main className="conversation project-main">
        <header className="conv-header">
          {!sidebarOpen && (
            <button type="button" className="icon-button" onClick={onToggleSidebar} aria-label="Show sidebar" title="Show sidebar (Ctrl+B)">
              <PanelLeft size={14} />
            </button>
          )}
          <div className="conv-title-wrap">
            <h1 className="conv-title"><span>{state.project.name}</span></h1>
            <div className="conv-subtitle">
              {state.project.archived && <span className="conv-tag">Archived</span>}
              {working > 0 && <span className="conv-workspace">{working} thread{working === 1 ? '' : 's'} working</span>}
              {!connected && <span className="conv-workspace"><WifiOff size={12} /> Reconnecting…</span>}
            </div>
          </div>
          <div className="conv-header-actions">
            <BackgroundJobs workspace={workspace} onOpenBrowser={() => onWorkbench(current => openTool(current, 'browser'))} />
            <button
              type="button"
              className="icon-button"
              aria-label="Project settings"
              title="Project settings: instructions, memory, models"
              onClick={() => onWorkbench(current => openDoc(current, { kind: 'settings', label: 'Settings' }))}
            >
              <Settings2 size={14} />
            </button>
            <Menu
              label="Project actions"
              align="end"
              trigger={<MoreHorizontal size={14} />}
              items={[
                { key: 'pause', label: 'Pause all work', icon: <Pause size={14} />, onSelect: () => void pause(), disabled: working === 0 && !coordinatorRunning },
              ]}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => onWorkbench(toggle)}
              aria-label={workbench.open ? 'Hide panel' : 'Show panel'}
              title={workbench.open ? 'Hide panel (Ctrl+J)' : 'Show panel (Ctrl+J)'}
            >
              {workbench.open ? <PanelRightClose size={14} /> : <PanelRight size={14} />}
            </button>
          </div>
        </header>

        <div className="conv-scroll" ref={scroller} onScroll={() => {
          const el = scroller.current
          if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}>
          <div className="conv-column">
            {items.length === 0 && <ProjectEmpty name={state.project.name} coordinatorId={state.coordinatorId} />}
            <Room
              workspace={workspace}
              items={items}
              state={state}
              coordinatorRunning={coordinatorRunning}
              handlers={{ onOpenThread: openThread, onOpenExchange: openExchange, onReply: setReplyTarget, onJump: jump }}
            />
          </div>
        </div>

        <div className="conv-dock">
          <div className="conv-column">
            {notice && (
              <div className="notice notice-info">
                <span>{notice}</span>
              </div>
            )}
            {error && <div className="error-banner" role="alert"><span>{error}</span></div>}
            {state.approvals.map(approval => (
              <ApprovalCard key={approval.id} approval={approval} onAnswer={allow => void answer(approval.id, allow)} />
            ))}
            {replyTarget && (
              <div className="reply-bar">
                <CornerUpLeft size={14} />
                <span className="reply-bar-text">
                  Replying to <strong>{replyTarget.label}</strong>
                  <span className="reply-bar-excerpt">{replyTarget.excerpt}</span>
                </span>
                <button type="button" className="icon-button tiny" aria-label="Cancel reply" onClick={() => setReplyTarget(undefined)}><X size={14} /></button>
              </div>
            )}
            <PromptBox
              inline
              placeholder={replyTarget ? `Reply to ${replyTarget.label}…` : items.length ? 'Message the project…' : 'Describe what needs to get done…'}
              onSubmit={text => send(text)}
              onInterruptSubmit={text => send(text, true)}
              onStop={() => void stopMessageTarget()}
              running={messageTargetRunning}
              allowWhileRunning
              autoFocusKey={replyTarget?.id ?? projectId}
            />
          </div>
        </div>
      </main>
      {panelSlot && panel && createPortal(panel, panelSlot)}
      </LinkContext.Provider>
    </AvatarSeeds.Provider>
  )
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

type Group =
  | { kind: 'user'; id: string; at: number; items: Array<Extract<MainItem, { kind: 'user' }>> }
  | { kind: 'agent'; id: string; at: number; items: MainItem[] }
  | { kind: 'exchange'; id: string; at: number; item: Extract<MainItem, { kind: 'threads' }> }

/** How long one author can keep talking under the same head. */
const RUN_GAP_MS = 5 * 60_000

/** Runs of consecutive messages by one author, the way chat rooms group them. */
function group(items: readonly MainItem[]): Group[] {
  const out: Group[] = []
  for (const item of items) {
    if (item.kind === 'threads') {
      out.push({ kind: 'exchange', id: item.id, at: item.at, item })
      continue
    }
    const last = out.at(-1)
    const at = item.at
    if (item.kind === 'user') {
      if (last?.kind === 'user' && at - last.at < RUN_GAP_MS && sameDay(at, last.at)) last.items.push(item)
      else out.push({ kind: 'user', id: item.id, at, items: [item] })
      continue
    }
    if (last?.kind === 'agent' && at - last.at < RUN_GAP_MS && sameDay(at, last.at)) last.items.push(item)
    else out.push({ kind: 'agent', id: item.id, at, items: [item] })
  }
  return out
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

function dayLabel(at: number, now = Date.now()): string {
  if (sameDay(at, now)) return 'Today'
  if (sameDay(at, now - 86_400_000)) return 'Yesterday'
  return new Date(at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

interface RoomHandlers {
  onOpenExchange: (firstId: string, secondId: string) => void
  onOpenThread: (id: string) => void
  onReply: (ref: ReplyRef) => void
  onJump: (ref: ReplyRef) => void
}

/**
 * The main conversation as a chat room: every run of messages has its
 * author, avatar and time; days are separated; the coordinator "is typing"
 * instead of thinking.
 */
function Room({
  workspace,
  items,
  state,
  coordinatorRunning,
  handlers,
}: {
  workspace: string
  items: readonly MainItem[]
  state: ProjectState
  coordinatorRunning: boolean
  handlers: RoomHandlers
}) {
  const groups = group(items)
  const typing = coordinatorRunning
  let previousDay: number | undefined
  return (
    <div className="timeline room">
      {groups.map(entry => {
        const showDay = previousDay === undefined || !sameDay(previousDay, entry.at)
        previousDay = entry.at
        const day = showDay ? <div key={`day-${entry.id}`} className="room-day" role="separator"><span>{dayLabel(entry.at)}</span></div> : null
        if (entry.kind === 'exchange') {
          const { senderId, threadIds } = entry.item
          const content = <><span>Messaged</span><span className="message-receipt-avatars">{threadIds.map(id => <AgentAvatar key={id} id={id} role={id === state.coordinatorId ? 'coordinator' : 'agent'} size={18} />)}</span><span>{threadIds.length === 1 ? agentLabel(state, threadIds[0]!) : `${threadIds.length} Agents`}</span></>
          return [day, <div key={entry.id} className="message-receipt" title={`From ${agentLabel(state, senderId)}`}>
            {threadIds.length === 1
              ? <button type="button" className="message-receipt-open" aria-label={`Open conversation with ${agentLabel(state, threadIds[0]!)}`} onClick={() => handlers.onOpenExchange(senderId, threadIds[0]!)}>{content}</button>
              : <Menu className="message-receipt-open" label={`Messaged ${threadIds.length} Agents`} trigger={content} items={threadIds.map(id => ({ key: id, label: agentLabel(state, id), onSelect: () => handlers.onOpenExchange(senderId, id) }))} />}
            {threadIds.filter(id => id !== state.coordinatorId).map(id => <button key={id} type="button" className="icon-button tiny message-receipt-reply" aria-label={`Reply to ${agentLabel(state, id)}`} title={`Message ${agentLabel(state, id)}`} onClick={() => handlers.onReply({ id: entry.id, who: 'thread', threadId: id, agentId: id, label: agentLabel(state, id), excerpt: '', inMain: false })}><CornerUpLeft size={12} /></button>)}
          </div>]
        }
        if (entry.kind === 'user') {
          return [
            day,
            <Run key={entry.id} side="user" author="You" at={entry.at} avatar={<span className="room-avatar-you" aria-hidden>Y</span>}>
              {entry.items.map(item => (
                <div key={item.id} id={`msg-${item.id}`} className="room-message">
                  {item.replyTo.map(ref => <ReplyChip key={ref.id} reply={ref} onJump={handlers.onJump} />)}
                  <Markdown text={item.text} />
                </div>
              ))}
            </Run>,
          ]
        }
        return [
          day,
          <Run
            key={entry.id}
            side="agent"
            author="Coordinator"
            at={entry.at}
            avatar={<AgentAvatar id={state.coordinatorId} role="coordinator" size={20} live={coordinatorRunning && entry === groups.at(-1)} title="Coordinator" />}
          >
            {entry.items.map(item => {
              switch (item.kind) {
                case 'coordinator':
                  return (
                    <div key={item.id} id={`msg-${item.id}`} className="room-message main-message">
                      {item.replyTo.map(ref => <ReplyChip key={ref.id} reply={ref} onJump={handlers.onJump} />)}
                      {item.text.trim() && <Markdown text={item.text} />}
                      <ArtifactCards workspace={workspace} projectId={state.project.id} artifacts={artifactsFor(state, item.refs)} />
                      <div className="turn-actions">
                        <button
                          type="button"
                          className="icon-button tiny"
                          aria-label="Reply to this message"
                          title="Reply"
                          onClick={() => handlers.onReply({ id: item.id, who: 'coordinator', label: 'Coordinator', agentId: state.coordinatorId, excerpt: plainPreview(item.text, 110), inMain: true })}
                        >
                          <CornerUpLeft size={14} />
                        </button>
                      </div>
                    </div>
                  )
                default:
                  return null
              }
            })}
          </Run>,
        ]
      })}
      {typing && (
        <div className="room-typing" role="status">
          <span className="thinking-dots" aria-hidden><i /><i /><i /></span>
          <span><strong>Coordinator</strong> is typing…</span>
        </div>
      )}
    </div>
  )
}

/** "↩ Audit math module: Found one bug…" — what a message is answering. */
export function ReplyChip({ reply, onJump, align = 'start' }: { reply: ReplyRef; onJump: (ref: ReplyRef) => void; align?: 'start' | 'end' }) {
  return (
    <button
      type="button"
      className={`reply-chip align-${align} who-${reply.who}`}
      onClick={() => onJump(reply)}
      title={reply.inMain ? 'Jump to message' : reply.threadId ? 'Open thread' : undefined}
    >
      <CornerUpLeft size={12} className="reply-chip-arrow" />
      {reply.agentId
        ? <AgentAvatar id={reply.agentId} role={reply.who === 'coordinator' ? 'coordinator' : 'agent'} size={14} />
        : <span className="reply-chip-you" aria-hidden>{reply.label.charAt(0)}</span>}
      <span className="reply-chip-label">{reply.label}</span>
      <span className="reply-chip-text">{reply.excerpt}</span>
    </button>
  )
}

function ProjectEmpty({ name, coordinatorId }: { name: string; coordinatorId: string }) {
  return (
    <div className="empty-state">
      <AgentAvatar id={coordinatorId} role="coordinator" size={56} title="Your coordinator (click to change its look)" rerollable />
      <h2>What should {name} get done?</h2>
      <p>Talk here like you would with a teammate. Each focused task gets its own thread; follow them on the Board, and find what they make in the Library.</p>
    </div>
  )
}

/** Per project: thread id → the `updatedAt` the user last saw when they opened it. */
function useSeenThreads(projectId: string): [Readonly<Record<string, number>>, (threadId: string, updatedAt: number) => void] {
  const key = `tnega.project.seen.${projectId}`
  const read = useCallback((): Record<string, number> => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
      if (!parsed || typeof parsed !== 'object') return {}
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
    } catch {
      return {}
    }
  }, [key])
  const [seen, setSeen] = useState(read)
  useEffect(() => setSeen(read()), [read])
  const mark = useCallback((threadId: string, updatedAt: number) => {
    setSeen(current => {
      if ((current[threadId] ?? 0) >= updatedAt) return current
      const next = { ...current, [threadId]: updatedAt }
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Storage can be unavailable; unread dots then last for the session.
      }
      return next
    })
  }, [key])
  return [seen, mark]
}
