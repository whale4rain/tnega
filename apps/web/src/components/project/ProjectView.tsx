import {
  BookOpen,
  Brain,
  LayoutList,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  Pause,
  Settings2,
  WifiOff,
  Rocket,
  Search,
  FileSearch,
  Workflow,
  CornerUpLeft,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { avatarVersion, distinctSeeds, subscribeAvatars } from '../../lib/avatar'
import { errorText, useStoredState } from '../../lib/hooks'
import { followProject, isUnsupported, localReplies, projectApi } from '../../lib/project-api'
import { activeCount, fromSnapshot, mainTimeline, plainPreview, reduceProject, workerThreads, type MainItem, type ProjectState, type ReplyRef } from '../../lib/project-model'
import type { ProjectStreamEvent } from '../../lib/project-types'
import type { ConfigSnapshot } from '../../lib/types'
import { AgentAvatar, AvatarSeeds } from '../AgentAvatar'
import { PromptBox } from '../Composer'
import { ApprovalCard } from '../Conversation'
import { Markdown } from '../Markdown'
import { Menu } from '../Menu'
import { LibraryPanel, MemoryPanel, OverviewPanel, SettingsPanel } from './ProjectPanels'
import { ThreadCard } from './ThreadCard'
import { ThreadPanel } from './ThreadPanel'

type Tab = 'overview' | 'memory' | 'library' | 'settings'

const TABS: Array<{ key: Tab; label: string; icon: typeof Brain }> = [
  { key: 'overview', label: 'Overview', icon: LayoutList },
  { key: 'memory', label: 'Memory', icon: Brain },
  { key: 'library', label: 'Library', icon: BookOpen },
  { key: 'settings', label: 'Settings', icon: Settings2 },
]

export function ProjectView({
  workspace,
  projectId,
  threadId,
  config,
  onOpenThread,
  onDeleted,
  onChanged,
  sidebarOpen,
  onToggleSidebar,
}: {
  workspace: string
  projectId: string
  threadId: string | undefined
  config: ConfigSnapshot | undefined
  onOpenThread: (threadId: string | undefined) => void
  onDeleted: () => void
  onChanged: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
}) {
  const [state, setState] = useState<ProjectState | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [connected, setConnected] = useState(true)
  const [tab, setTab] = useStoredState<Tab>('tnega.projectTab', 'overview', ['overview', 'memory', 'library', 'settings'])
  const [panelOpen, setPanelOpen] = useStoredState<'open' | 'closed'>('tnega.projectPanel', 'open', ['open', 'closed'])
  const [notice, setNotice] = useState<string | undefined>()
  const [replyTarget, setReplyTarget] = useState<ReplyRef | undefined>()

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

  const items = useMemo(() => (state ? mainTimeline(state) : []), [state])
  const coordinatorRunning = state ? Boolean(state.running[state.coordinatorId]) : false

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

  const send = useCallback(async (text: string) => {
    const replyTo = replyTarget?.id
    try {
      const receipt = await projectApi.send(workspace, projectId, text, replyTo)
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
  }, [workspace, projectId, replyTarget])

  /** Scroll to a message in the conversation, or open the thread it came from. */
  const jump = useCallback((ref: ReplyRef) => {
    const target = ref.inMain ? document.getElementById(`msg-${ref.id}`) : null
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.classList.remove('flash')
      void target.offsetWidth
      target.classList.add('flash')
    } else if (ref.threadId) {
      onOpenThread(ref.threadId)
    }
  }, [onOpenThread])

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
  const showPanel = panelOpen === 'open' || Boolean(threadId)

  return (
    <AvatarSeeds.Provider value={seeds}>
    <div className={`project-view${showPanel ? ' with-panel' : ''}`}>
      <main className="conversation project-main">
        <header className="conv-header">
          {!sidebarOpen && (
            <button type="button" className="icon-button" onClick={onToggleSidebar} aria-label="Show sidebar" title="Show sidebar (Ctrl+B)">
              <PanelLeft size={17} />
            </button>
          )}
          <div className="conv-title-wrap">
            <h1 className="conv-title"><span>{state.project.name}</span></h1>
            <div className="conv-subtitle">
              <span className="conv-tag project-tag">Project</span>
              {state.project.archived && <span className="conv-tag">Archived</span>}
              {working > 0 && <span className="conv-tag goal-active"><span className="spinner tiny" /> {working} thread{working === 1 ? '' : 's'} working</span>}
              {!connected && <span className="conv-tag goal-blocked"><WifiOff size={11} /> Reconnecting…</span>}
              {state.project.goal && <span className="conv-workspace" title={state.project.goal}>{state.project.goal}</span>}
            </div>
          </div>
          <div className="conv-header-actions">
            <Menu
              label="Project actions"
              align="end"
              trigger={<MoreHorizontal size={17} />}
              items={[
                { key: 'pause', label: 'Pause all work', icon: <Pause size={14} />, onSelect: () => void pause(), disabled: working === 0 && !coordinatorRunning },
                { key: 'settings', label: 'Project settings', icon: <Settings2 size={14} />, onSelect: () => { setTab('settings'); setPanelOpen('open'); onOpenThread(undefined) } },
              ]}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                if (showPanel) {
                  setPanelOpen('closed')
                  onOpenThread(undefined)
                } else {
                  setPanelOpen('open')
                }
              }}
              aria-label={showPanel ? 'Hide panel' : 'Show panel'}
              title={showPanel ? 'Hide panel' : 'Show panel'}
            >
              {showPanel ? <PanelRightClose size={17} /> : <PanelRight size={17} />}
            </button>
          </div>
        </header>

        <div className="conv-scroll" ref={scroller} onScroll={() => {
          const el = scroller.current
          if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}>
          <div className="conv-column">
            {items.length === 0 && <ProjectEmpty name={state.project.name} coordinatorId={state.coordinatorId} onPick={text => void send(text)} />}
            <MainTimeline
              items={items}
              state={state}
              activeThread={threadId}
              coordinatorRunning={coordinatorRunning}
              handlers={{
                onOpenThread: id => onOpenThread(id === threadId ? undefined : id),
                onReply: setReplyTarget,
                onJump: jump,
              }}
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
              placeholder={replyTarget ? `Reply to ${replyTarget.label}…` : items.length ? 'Message the coordinator… you can send while threads are working' : 'Describe what needs to get done…'}
              onSubmit={send}
              running={coordinatorRunning}
              autoFocusKey={replyTarget?.id ?? projectId}
              footer={<span>The coordinator decides whether to answer, start a thread, or steer one that is running.</span>}
            />
          </div>
        </div>
      </main>

      {showPanel && (
        <aside className="project-side" aria-label="Project panel">
          {threadId
            ? <ThreadPanel workspace={workspace} state={state} threadId={threadId} onBack={() => onOpenThread(undefined)} />
            : (
              <div className="side-panel">
                <div className="side-tabs" role="tablist">
                  {TABS.map(item => (
                    <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={tab === item.key ? 'active' : undefined} onClick={() => setTab(item.key)}>
                      <item.icon size={14} />
                      <span>{item.label}</span>
                      {item.key === 'overview' && working > 0 && <span className="tab-badge">{working}</span>}
                    </button>
                  ))}
                </div>
                <div className="side-scroll">
                  {tab === 'overview' && <OverviewPanel state={state} onOpenThread={onOpenThread} />}
                  {tab === 'memory' && <MemoryPanel workspace={workspace} state={state} />}
                  {tab === 'library' && <LibraryPanel workspace={workspace} state={state} />}
                  {tab === 'settings' && <SettingsPanel key={state.project.id} workspace={workspace} state={state} config={config} onDeleted={onDeleted} />}
                </div>
              </div>
            )}
        </aside>
      )}
    </div>
    </AvatarSeeds.Provider>
  )
}

// ---------------------------------------------------------------------------

type Group =
  | { kind: 'user'; item: Extract<MainItem, { kind: 'user' }> }
  | { kind: 'notice'; item: Extract<MainItem, { kind: 'notice' }> }
  | { kind: 'agent'; id: string; items: MainItem[] }

function group(items: readonly MainItem[]): Group[] {
  const out: Group[] = []
  for (const item of items) {
    if (item.kind === 'user' || item.kind === 'notice') {
      out.push({ kind: item.kind, item } as Group)
      continue
    }
    const last = out.at(-1)
    if (last?.kind === 'agent') last.items.push(item)
    else out.push({ kind: 'agent', id: item.id, items: [item] })
  }
  return out
}

interface TimelineHandlers {
  onOpenThread: (id: string) => void
  onReply: (ref: ReplyRef) => void
  onJump: (ref: ReplyRef) => void
}

function MainTimeline({
  items,
  state,
  activeThread,
  coordinatorRunning,
  handlers,
}: {
  items: readonly MainItem[]
  state: ProjectState
  activeThread: string | undefined
  coordinatorRunning: boolean
  handlers: TimelineHandlers
}) {
  const groups = group(items)
  const last = groups.at(-1)
  const drafting = items.at(-1)?.kind === 'draft'
  const thinking = coordinatorRunning && !drafting
  return (
    <div className="timeline">
      {groups.map((entry, index) => {
        if (entry.kind === 'user') {
          return (
            <div key={entry.item.id} id={`msg-${entry.item.id}`} className="user-row">
              {entry.item.replyTo.map(ref => <ReplyChip key={ref.id} reply={ref} onJump={handlers.onJump} align="end" />)}
              <div className="user-bubble">{entry.item.text}</div>
            </div>
          )
        }
        if (entry.kind === 'notice') {
          return (
            <div key={entry.item.id} id={`msg-${entry.item.id}`} className="project-notice">
              {entry.item.threadId
                ? <button type="button" className="link-button" onClick={() => handlers.onOpenThread(entry.item.threadId!)}>{entry.item.text}</button>
                : entry.item.text}
            </div>
          )
        }
        const live = thinking && index === groups.length - 1
        return (
          <AgentGroup key={entry.id} agentId={state.coordinatorId} live={live || (drafting && entry === last)}>
            {entry.items.map(item => {
              switch (item.kind) {
                case 'coordinator':
                  return (
                    <div key={item.id} id={`msg-${item.id}`} className="main-message">
                      {item.replyTo.map(ref => <ReplyChip key={ref.id} reply={ref} onJump={handlers.onJump} />)}
                      <Markdown text={item.text} />
                      <div className="turn-actions">
                        <button
                          type="button"
                          className="icon-button tiny"
                          aria-label="Reply to this message"
                          title="Reply to this message"
                          onClick={() => handlers.onReply({ id: item.id, who: 'coordinator', label: 'Coordinator', agentId: state.coordinatorId, excerpt: plainPreview(item.text, 110), inMain: true })}
                        >
                          <CornerUpLeft size={14} />
                        </button>
                      </div>
                    </div>
                  )
                case 'draft':
                  return <div key={item.id} className="streaming"><Markdown text={item.text} /></div>
                case 'threads':
                  return (
                    <div key={item.id} className="thread-stack">
                      {item.threadIds.map(id => (
                        <ThreadCard
                          key={id}
                          state={state}
                          threadId={id}
                          active={id === activeThread}
                          onOpen={handlers.onOpenThread}
                          onReply={handlers.onReply}
                        />
                      ))}
                    </div>
                  )
                default:
                  return null
              }
            })}
            {live && <Coordinating />}
          </AgentGroup>
        )
      })}
      {thinking && last?.kind !== 'agent' && (
        <AgentGroup agentId={state.coordinatorId} live><Coordinating /></AgentGroup>
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
        ? <AgentAvatar id={reply.agentId} role={reply.who === 'coordinator' ? 'coordinator' : 'agent'} size={16} />
        : <span className="reply-chip-you" aria-hidden>{reply.label.charAt(0)}</span>}
      <span className="reply-chip-label">{reply.label}</span>
      <span className="reply-chip-text">{reply.excerpt}</span>
    </button>
  )
}

function AgentGroup({ children, live, agentId }: { children: ReactNode; live?: boolean; agentId: string }) {
  return (
    <div className={`agent-turn${live ? ' is-live' : ''}`}>
      <div className="agent-avatar"><AgentAvatar id={agentId} role="coordinator" size={28} live={Boolean(live)} title="Coordinator" /></div>
      <div className="agent-body">{children}</div>
    </div>
  )
}

function Coordinating() {
  return (
    <div className="thinking" role="status">
      <span className="thinking-dots" aria-hidden><i /><i /><i /></span>
      <span className="shimmer">Coordinating</span>
    </div>
  )
}

const STARTERS = [
  { icon: Rocket, title: 'Ship a release', prompt: 'Get this project ready for its next release: audit open issues, fix what blocks the release, and draft release notes.' },
  { icon: FileSearch, title: 'Research in parallel', prompt: 'Compare three approaches to adding authentication here, in parallel, and recommend one with trade-offs.' },
  { icon: Search, title: 'Audit the codebase', prompt: 'Audit this workspace for bugs, missing tests and outdated dependencies; split the work by area.' },
  { icon: Workflow, title: 'Plan the work', prompt: 'Break our goal into workstreams, propose which should run in parallel, and ask me before starting.' },
]

function ProjectEmpty({ name, coordinatorId, onPick }: { name: string; coordinatorId: string; onPick: (text: string) => void }) {
  return (
    <div className="empty-state">
      <AgentAvatar id={coordinatorId} role="coordinator" size={72} live title="Your coordinator (click to change its look)" rerollable />
      <h2>What should {name} get done?</h2>
      <p>Describe the outcome. The coordinator splits it into threads that work in parallel, share memory, and report back here.</p>
      <div className="starter-grid">
        {STARTERS.map(starter => (
          <button key={starter.title} type="button" className="starter" onClick={() => onPick(starter.prompt)}>
            <starter.icon size={16} />
            <span className="starter-title">{starter.title}</span>
            <span className="starter-prompt">{starter.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
