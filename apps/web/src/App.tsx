import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Ref } from 'react'
import { ConversationNav } from './ConversationNav'
import { ThemeToggle, type ThemePreference } from './ThemeToggle'
import {
  addWorkspace,
  ApiError,
  compactSession,
  createSession,
  deleteSession,
  displayPath,
  forkSession,
  formatTime,
  getConfig,
  getSession,
  listSessions,
  listWorkspaces,
  prettyJson,
  removeWorkspace,
  renameSession,
  saveConfig,
  stopRun,
  streamRun,
  truncateSession,
} from './api'
import type {
  ConfigSnapshot,
  ContextUsage,
  DisplayMessage,
  ModelMessage,
  SessionEvent,
  SessionDetail,
  SessionSummary,
  StreamEvent,
} from './types'

type View = 'chat' | 'settings'
type RunState = 'idle' | 'running' | 'cancelling'

const THEME_STORAGE_KEY = 'tnega-theme'

function initialThemePreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored
  }
  return 'system'
}

function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference === 'light' || preference === 'dark') return preference
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const MODEL_OPTIONS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
  'gpt-5.2',
  'gpt-5.1',
]

export default function App() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    initialThemePreference,
  )
  const [config, setConfig] = useState<ConfigSnapshot | null>(null)
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [context, setContext] = useState<ContextUsage | null>(null)
  const [sessionRunning, setSessionRunning] = useState(false)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [view, setView] = useState<View>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolveTheme(themePreference)
    localStorage.setItem(THEME_STORAGE_KEY, themePreference)
    if (themePreference !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = () => {
      root.dataset.theme = resolveTheme('system')
    }
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [themePreference])

  useEffect(() => {
    let cancelled = false
    void Promise.all([getConfig(), listWorkspaces()])
      .then(([nextConfig, nextWorkspaces]) => {
        if (cancelled) return
        setConfig(nextConfig)
        const stored = nextWorkspaces.workspaces
        setWorkspaces(stored)
        if (stored.length && !workspace) setWorkspace(stored[0]!)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageOf(reason))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    api.listSessions(workspace)
      .then(({ sessions: next }) => {
        if (cancelled) return
        setSessions(next)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageOf(reason))
      })
    return () => {
      cancelled = true
    }
  }, [workspace])

  const selectSession = useCallback((id: string) => {
    if (!workspace) return
    setSessionId(id)
    setError(null)
    setMessages([])
    api.getSession(workspace, id)
      .then(detail => {
        setSummary(detail.summary)
        setContext(detail.context)
        setSessionRunning(detail.running)
        setMessages(projectEvents(detail.events))
      })
      .catch((reason: unknown) => setError(messageOf(reason)))
  }, [workspace])

  const refreshSession = useCallback(async (id: string) => {
    if (!workspace) return
    const detail = await api.getSession(workspace, id)
    setSummary(detail.summary)
    setContext(detail.context)
    setSessionRunning(detail.running)
    setMessages(projectEvents(detail.events))
    const next = await api.listSessions(workspace)
    setSessions(next.sessions)
    return detail
  }, [workspace])

  async function handleAddWorkspace(path: string) {
    if (!path.trim()) return
    try {
      const result = await api.addWorkspace(path.trim())
      setWorkspaces(result.workspaces)
      setWorkspace(result.path)
      setSessions([])
      setSessionId(null)
      setSummary(null)
      setContext(null)
      setSessionRunning(false)
      setMessages([])
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleRemoveWorkspace(path: string) {
    try {
      const result = await api.removeWorkspace(path)
      setWorkspaces(result.workspaces)
      if (workspace === path) {
        setWorkspace(null)
        setSessions([])
        setSessionId(null)
        setSummary(null)
        setContext(null)
        setSessionRunning(false)
        setMessages([])
      }
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleNewSession() {
    if (!workspace) return
    try {
      const { session } = await api.createSession(workspace)
      setSessions(current => [session, ...current])
      selectSession(session.id)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleRename(id: string, title: string) {
    if (!workspace || !title.trim()) return
    try {
      const { summary: next } = await api.renameSession(workspace, id, title.trim())
      setSessions(current => current.map(session => session.id === id ? next : session))
      if (sessionId === id) setSummary(next)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleFork(id: string) {
    if (!workspace) return
    try {
      const { session } = await api.forkSession(workspace, id)
      setSessions(current => [session, ...current])
      selectSession(session.id)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleForkAt(id: string, messageId: string) {
    if (!workspace) return
    try {
      const { session } = await api.forkSession(workspace, id, { messageId })
      setSessions(current => [session, ...current])
      selectSession(session.id)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleDelete(id: string) {
    if (!workspace) return
    if (!window.confirm(`delete session ${id.slice(0, 8)}?`)) return
    try {
      await api.deleteSession(workspace, id)
      setSessions(current => current.filter(session => session.id !== id))
      if (sessionId === id) {
        setSessionId(null)
        setSummary(null)
        setContext(null)
        setSessionRunning(false)
        setMessages([])
      }
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleConfigSaved(next: ConfigSnapshot) {
    setConfig(next)
    setView('chat')
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">tnega web</div>
        <div className="workspace-label" title={workspace ?? ''}>
          {workspace ? displayPath(workspace) : 'no workspace'}
        </div>
        <div className="topbar-actions">
          <ThemeToggle
            value={themePreference}
            onChange={setThemePreference}
          />
          <button
            type="button"
            className="menu-button"
            onClick={() => setSidebarOpen(open => !open)}
            title="sidebar"
          >
            [menu]
          </button>
          <button
            type="button"
            className={view === 'settings' ? 'tab-active' : ''}
            onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
          >
            {view === 'settings' ? '[chat]' : '[settings]'}
          </button>
        </div>
      </header>
      <div className="body">
        <aside className={sidebarOpen ? 'sidebar open' : 'sidebar'}>
          <WorkspacePane
            workspaces={workspaces}
            current={workspace}
            onSelect={setWorkspace}
            onAdd={handleAddWorkspace}
            onRemove={handleRemoveWorkspace}
          />
          <SessionPane
            sessions={sessions}
            workspace={workspace}
            selectedId={sessionId}
            onSelect={selectSession}
            onNew={handleNewSession}
            onRename={handleRename}
            onFork={handleFork}
            onDelete={handleDelete}
          />
        </aside>
        <main className="main">
          {error && (
            <div className="error-banner" role="alert">
              <span className="marker">[!]</span>
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} title="dismiss">[x]</button>
            </div>
          )}
          {view === 'settings' ? (
            <SettingsView config={config} onSaved={handleConfigSaved} />
          ) : (
            <ChatView
              workspace={workspace}
              sessionId={sessionId}
              summary={summary}
              context={context}
              sessionRunning={sessionRunning}
              messages={messages}
              apiKeySet={config?.apiKeySet ?? false}
              onNewSession={handleNewSession}
              onRefresh={refreshSession}
              onForkAt={handleForkAt}
              onMessagesChange={setMessages}
            />
          )}
        </main>
      </div>
      {sidebarOpen && (
        <button
          type="button"
          className="backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-label="close sidebar"
        />
      )}
    </div>
  )
}

interface WorkspacePaneProps {
  workspaces: string[]
  current: string | null
  onSelect: (path: string) => void
  onAdd: (path: string) => Promise<void>
  onRemove: (path: string) => Promise<void>
}

function WorkspacePane({
  workspaces,
  current,
  onSelect,
  onAdd,
  onRemove,
}: WorkspacePaneProps) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!path.trim() || busy) return
    setBusy(true)
    try {
      await onAdd(path)
      setPath('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pane">
      <div className="pane-header">
        <span>[workspaces]</span>
        <span className="count">{workspaces.length}</span>
      </div>
      <div className="pane-list">
        {workspaces.map(item => (
          <div
            key={item}
            className={item === current ? 'workspace-row active' : 'workspace-row'}
          >
            <button
              type="button"
              className="workspace-select"
              onClick={() => onSelect(item)}
              title={item}
            >
              <span className="marker">{item === current ? '[x]' : '[ ]'}</span>
              <span className="ellipsis">{displayPath(item)}</span>
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => void onRemove(item)}
              title="remove workspace"
            >
              [x]
            </button>
          </div>
        ))}
        {!workspaces.length && <div className="empty-line">none</div>}
      </div>
      <div className="pane-form">
        <input
          type="text"
          value={path}
          onChange={event => setPath(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') void submit()
          }}
          placeholder="absolute path"
          spellCheck={false}
        />
        <button type="button" onClick={() => void submit()} disabled={busy} title="add workspace">
          [+]
        </button>
      </div>
    </section>
  )
}

interface SessionPaneProps {
  sessions: SessionSummary[]
  workspace: string | null
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => Promise<void>
  onRename: (id: string, title: string) => Promise<void>
  onFork: (id: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

function SessionPane({
  sessions,
  workspace,
  selectedId,
  onSelect,
  onNew,
  onRename,
  onFork,
  onDelete,
}: SessionPaneProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  function beginRename(session: SessionSummary) {
    setEditingId(session.id)
    setDraft(session.title)
  }

  async function commitRename() {
    if (editingId) {
      await onRename(editingId, draft)
    }
    setEditingId(null)
  }

  return (
    <section className="pane sessions-pane">
      <div className="pane-header">
        <span>[sessions]</span>
        <div className="pane-header-actions">
          <span className="count">{sessions.length}</span>
          <button
            type="button"
            className="icon-button"
            onClick={() => void onNew()}
            disabled={!workspace}
            title="new session"
          >
            [+]
          </button>
        </div>
      </div>
      <div className="pane-list">
        {sessions.map(session => (
          <div
            key={session.id}
            className={session.id === selectedId ? 'session-row active' : 'session-row'}
          >
            {editingId === session.id ? (
              <input
                type="text"
                className="rename-input"
                value={draft}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void commitRename()
                  if (event.key === 'Escape') setEditingId(null)
                }}
                autoFocus
                spellCheck={false}
              />
            ) : (
              <button
                type="button"
                className="session-select"
                onClick={() => onSelect(session.id)}
                title={`${session.id}\n${formatTime(session.updatedAt)}`}
              >
                <span className="session-title ellipsis">{session.title}</span>
                <span className="session-meta">
                  {formatTime(session.updatedAt)} {session.eventCount}
                </span>
              </button>
            )}
            <div className="session-actions">
              <button
                type="button"
                className="icon-button"
                onClick={() => beginRename(session)}
                title="rename"
              >
                [r]
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => void onFork(session.id)}
                title="fork"
              >
                [f]
              </button>
              <button
                type="button"
                className="icon-button danger"
                onClick={() => void onDelete(session.id)}
                title="delete"
              >
                [x]
              </button>
            </div>
          </div>
        ))}
        {!sessions.length && <div className="empty-line">none</div>}
      </div>
    </section>
  )
}

interface ChatViewProps {
  workspace: string | null
  sessionId: string | null
  summary: SessionSummary | null
  context: ContextUsage | null
  sessionRunning: boolean
  messages: DisplayMessage[]
  apiKeySet: boolean
  onNewSession: () => Promise<void>
  onRefresh: (id: string) => Promise<SessionDetail | undefined>
  onForkAt: (id: string, messageId: string) => Promise<void>
  onMessagesChange: (
    updater: (current: DisplayMessage[]) => DisplayMessage[],
  ) => void
}

function ChatView({
  workspace,
  sessionId,
  summary,
  context,
  sessionRunning,
  messages,
  apiKeySet,
  onNewSession,
  onRefresh,
  onForkAt,
  onMessagesChange,
}: ChatViewProps) {
  const [prompt, setPrompt] = useState('')
  const [allowNetwork, setAllowNetwork] = useState(false)
  const [allowShell, setAllowShell] = useState(false)
  const [runState, setRunState] = useState<RunState>('idle')
  const [compacting, setCompacting] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [navIndex, setNavIndex] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const runStateRef = useRef<RunState>('idle')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const userRefs = useRef(new Map<string, HTMLDivElement>())
  const stickToBottomRef = useRef(true)
  const streamDeltaRef = useRef(new Map<string, string>())
  const streamFlushFrameRef = useRef<number | null>(null)
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const userIndexes = useMemo(() => {
    const indexes: number[] = []
    messages.forEach((message, index) => {
      if (message.role === 'user') indexes.push(index)
    })
    return indexes
  }, [messages])

  const scrollToBottom = useCallback(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [])

  useEffect(() => {
    setNavIndex(0)
    userRefs.current.clear()
    stickToBottomRef.current = true
    setEditingId(null)
    setEditDraft('')
    scrollToBottom()
  }, [scrollToBottom, sessionId, workspace])

  useEffect(() => {
    runStateRef.current = runState
  }, [runState])

  useEffect(() => {
    if (sessionRunning && runStateRef.current === 'idle') setRunState('running')
  }, [sessionRunning])

  useEffect(() => {
    if (!sessionRunning || !workspace || !sessionId) return
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const detail = await onRefresh(sessionId)
        if (cancelled) return
        if (detail?.running && runStateRef.current === 'idle') {
          setRunState('running')
        } else if (!detail?.running) {
          setRunState('idle')
        }
      } catch (reason) {
        if (!cancelled) setRunError(messageOf(reason))
      }
    }
    const timer = setInterval(() => { void poll() }, 1000)
    void poll()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [onRefresh, sessionId, sessionRunning, workspace])

  useEffect(() => {
    if (navIndex >= userIndexes.length) {
      setNavIndex(userIndexes.length === 0 ? 0 : userIndexes.length - 1)
    }
  }, [navIndex, userIndexes.length])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    scrollToBottom()
    if (userIndexes.length) setNavIndex(userIndexes.length - 1)
  }, [messages, scrollToBottom, userIndexes.length])

  function handleMessagesScroll() {
    const node = scrollRef.current
    if (!node) return
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80
    stickToBottomRef.current = nearBottom
    setShowJump(!nearBottom && node.scrollHeight > node.clientHeight + 1)
    updateActiveUserFromScroll()
  }

  function updateActiveUserFromScroll() {
    const node = scrollRef.current
    if (!node) return
    const threshold = node.scrollTop + node.clientHeight * 0.5
    let activeIndex = 0
    let bestDistance = Infinity
    for (let index = 0; index < userIndexes.length; index += 1) {
      const message = messages[userIndexes[index]]
      const element = message ? userRefs.current.get(message.id) : undefined
      if (!element) continue
      const top = element.getBoundingClientRect().top
        - node.getBoundingClientRect().top
        + node.scrollTop
      const distance = Math.abs(top - threshold)
      if (distance < bestDistance) {
        bestDistance = distance
        activeIndex = index
      }
    }
    if (activeIndex !== navIndex) setNavIndex(activeIndex)
  }

  function jumpToBottom() {
    stickToBottomRef.current = true
    setShowJump(false)
    scrollToBottom()
  }

  function scrollToUserMessage(targetIndex: number) {
    const messageIndex = userIndexes[targetIndex]
    if (messageIndex === undefined) return
    const target = messages[messageIndex]
    const node = target ? userRefs.current.get(target.id) : undefined
    if (!node) return
    stickToBottomRef.current = false
    setShowJump(true)
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function goToUser(offset: number) {
    const next = Math.min(
      Math.max(navIndex + offset, 0),
      Math.max(userIndexes.length - 1, 0),
    )
    if (next === navIndex) return
    setNavIndex(next)
    scrollToUserMessage(next)
  }

  const running = runState === 'running' || runState === 'cancelling'

  async function runPrompt(text: string) {
    const sent = text.trim()
    if (!workspace || !sessionId || !sent || running || compacting) return
    if (!apiKeySet) {
      setRunError('API key is not configured')
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setRunError(null)
    setRunState('running')
    stickToBottomRef.current = true
    setShowJump(false)
    setNavIndex(userIndexes.length)
    onMessagesChange(current => [
      ...current,
      {
        id: `live-user-${Date.now()}`,
        role: 'user',
        content: sent,
      },
    ])
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await api.streamRun(
            workspace,
            sessionId,
            {
              prompt: sent,
              allowNetwork,
              allowShell,
            },
            event => handleStreamEvent(event),
            controller.signal,
          )
          flushStreamDeltas()
          break
        } catch (reason) {
          if (
            reason instanceof ApiError
            && reason.status === 409
            && attempt < 10
            && !controller.signal.aborted
          ) {
            await delay(400)
            continue
          }
          throw reason
        }
      }
      await onRefresh(sessionId)
    } catch (reason) {
      if (controller.signal.aborted) {
        await delay(300)
        await onRefresh(sessionId)
      } else {
        setRunError(messageOf(reason))
      }
    } finally {
      abortRef.current = null
      setRunState('idle')
    }
  }

  function startRun() {
    if (!prompt.trim()) return
    const sent = prompt.trim()
    setPrompt('')
    void runPrompt(sent)
  }

  async function cancelRun() {
    if (runState !== 'running') return
    if (!workspace || !sessionId) return
    setRunState('cancelling')
    try {
      await api.stopRun(workspace, sessionId)
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        abortRef.current?.abort()
        return
      }
      setRunError(messageOf(reason))
      setRunState('running')
      return
    }
    abortRef.current?.abort()
  }

  function beginEdit(message: DisplayMessage) {
    setEditingId(message.id)
    setEditDraft(message.content)
    stickToBottomRef.current = false
  }

  function cancelEdit() {
    setEditingId(null)
    setEditDraft('')
  }

  async function submitEdit() {
    const content = editDraft.trim()
    const id = editingId
    if (!workspace || !sessionId || !id || !content) return
    if (!apiKeySet) {
      setRunError('API key is not configured')
      return
    }
    setEditingId(null)
    setEditDraft('')
    try {
      await api.truncateSession(workspace, sessionId, id)
      await onRefresh(sessionId)
    } catch (reason) {
      setRunError(messageOf(reason))
      return
    }
    await runPrompt(content)
  }

  function forkHere(messageId: string) {
    if (!sessionId) return
    void onForkAt(sessionId, messageId)
  }

  async function handleCompact() {
    if (!workspace || !sessionId || running || compacting) return
    setRunError(null)
    setCompacting(true)
    try {
      await api.compactSession(workspace, sessionId)
      await onRefresh(sessionId)
    } catch (reason) {
      setRunError(messageOf(reason))
    } finally {
      setCompacting(false)
    }
  }

  useEffect(() => {
    return () => {
      if (streamFlushFrameRef.current !== null) {
        cancelAnimationFrame(streamFlushFrameRef.current)
      }
      if (streamFlushTimerRef.current !== null) {
        clearTimeout(streamFlushTimerRef.current)
      }
    }
  }, [])

  function flushStreamDeltas() {
    if (streamFlushFrameRef.current !== null) {
      cancelAnimationFrame(streamFlushFrameRef.current)
      streamFlushFrameRef.current = null
    }
    if (streamFlushTimerRef.current !== null) {
      clearTimeout(streamFlushTimerRef.current)
      streamFlushTimerRef.current = null
    }
    const deltas = streamDeltaRef.current
    if (deltas.size === 0) return
    streamDeltaRef.current = new Map()
    onMessagesChange(current => applyStreamDeltas(current, deltas))
  }

  function scheduleStreamFlush() {
    if (streamFlushFrameRef.current !== null || streamFlushTimerRef.current !== null) {
      return
    }
    if (typeof requestAnimationFrame === 'function') {
      streamFlushFrameRef.current = requestAnimationFrame(() => {
        streamFlushFrameRef.current = null
        flushStreamDeltas()
      })
      return
    }
    streamFlushTimerRef.current = setTimeout(() => {
      streamFlushTimerRef.current = null
      flushStreamDeltas()
    }, 0)
  }

  function queueStreamDelta(id: string, delta: string) {
    const queued = streamDeltaRef.current.get(id) ?? ''
    streamDeltaRef.current.set(id, queued + delta)
    scheduleStreamFlush()
  }

  function applyStreamDeltas(
    current: DisplayMessage[],
    deltas: ReadonlyMap<string, string>,
  ): DisplayMessage[] {
    let next = current
    for (const [id, delta] of deltas) {
      const liveId = `live-${id}`
      const index = next.findIndex(message => message.id === liveId)
      if (index !== -1) {
        const entry = next[index]!
        next = next.map((message, messageIndex) =>
          messageIndex === index
            ? { ...entry, content: entry.content + delta, pending: true }
            : message,
        )
        continue
      }
      const fallback = findPendingAssistant(next) ?? lastAssistant(next)
      if (fallback) {
        next = next.map(message =>
          message === fallback
            ? { ...message, content: message.content + delta, pending: true }
            : message,
        )
        continue
      }
      next = [
        ...next,
        {
          id: liveId,
          role: 'assistant',
          content: delta,
          pending: true,
        },
      ]
    }
    return next
  }

  function handleStreamEvent(event: StreamEvent) {
    if (event.type === 'message_delta') {
      queueStreamDelta(event.id, event.delta)
      return
    }

    flushStreamDeltas()

    onMessagesChange(current => {
      switch (event.type) {
        case 'message_start':
          return [
            ...current,
            {
              id: `live-${event.id}`,
              role: 'assistant',
              content: '',
              pending: true,
            },
          ]
        case 'message_stop': {
          const id = `live-${event.id}`
          const target = current.find(message => message.id === id)
            ?? findPendingAssistant(current)
          if (!target) break
          return current.map(message =>
            message === target
              ? { ...message, pending: false, finishReason: event.finishReason }
              : message,
          )
        }
        case 'tool/start':
          return [
            ...current,
            {
              id: `live-tool-${event.call.id}`,
              role: 'tool',
              content: '',
              tool: {
                callId: event.call.id,
                name: event.call.name,
                argumentsText: prettyJson(event.call.arguments),
                status: 'pending',
              },
            },
          ]
        case 'tool/end': {
          let targetIndex = -1
          for (let index = current.length - 1; index >= 0; index -= 1) {
            const entry = current[index]
            if (
              entry
              && entry.role === 'tool'
              && entry.tool?.callId === event.call.id
              && entry.tool.status === 'pending'
            ) {
              targetIndex = index
              break
            }
          }
          if (targetIndex === -1) break
          const entry = current[targetIndex]!
          const tool = entry.tool!
          return current.map((message, messageIndex) =>
            messageIndex === targetIndex
              ? {
                  ...entry,
                  tool: {
                    ...tool,
                    status: 'done',
                    ok: event.result.ok,
                    outputText: event.result.output === undefined
                      ? undefined
                      : prettyJson(event.result.output),
                    errorText: event.result.error?.message,
                  },
                }
              : message,
          )
        }
        case 'run/end':
          return current.map(message =>
            message.role === 'assistant' && message.pending
              ? { ...message, pending: false }
              : message,
          )
        case 'error':
          return [
            ...current,
            {
              id: `live-error-${Date.now()}`,
              role: 'system',
              content: event.message,
            },
          ]
        default:
          return current
      }
      return current
    })
  }

  if (!workspace) {
    return (
      <div className="empty-state">
        <div className="empty-title">no workspace</div>
      </div>
    )
  }

  if (!sessionId || !summary) {
    return (
      <div className="empty-state">
        <div className="empty-title">no session</div>
        <button type="button" className="button-primary" onClick={() => void onNewSession()}>
          [+ new session]
        </button>
      </div>
    )
  }

  return (
    <div className="chat">
      <div className="chat-header">
        <div className="chat-title ellipsis" title={summary.id}>
          {summary.title}
        </div>
        <div className="chat-meta">
          <span>{displayPath(workspace)}</span>
          <span>{summary.eventCount} events</span>
          <span>{summary.id.slice(0, 8)}</span>
          <div className="chat-header-actions">
            {context && <ContextRing context={context} />}
            <button
              type="button"
              className="icon-button"
              onClick={() => void handleCompact()}
              disabled={running || compacting}
              title="compact context"
            >
              {compacting ? '[compacting]' : '[compact]'}
            </button>
          </div>
        </div>
      </div>
      <div className="messages-viewport">
        <div className="messages" ref={scrollRef} onScroll={handleMessagesScroll}>
          {messages.length === 0 && <div className="empty-line">no messages</div>}
          {messages.map((message, index) => (
            <MessageBlock
              key={message.id}
              message={message}
              active={message.role === 'user' && userIndexes[navIndex] === index}
              userRef={message.role === 'user'
                ? node => {
                    if (node) userRefs.current.set(message.id, node)
                    else userRefs.current.delete(message.id)
                  }
                : undefined}
              editing={editingId === message.id}
              editDraft={editingId === message.id ? editDraft : ''}
              onEditDraftChange={setEditDraft}
              onBeginEdit={message.role === 'user' && !running && !compacting
                ? () => beginEdit(message)
                : undefined}
              onSubmitEdit={message.role === 'user' && editingId === message.id
                ? () => void submitEdit()
                : undefined}
              onCancelEdit={message.role === 'user' && editingId === message.id
                ? cancelEdit
                : undefined}
              onForkAt={message.role === 'user' && !running && !compacting
                ? () => forkHere(message.id)
                : undefined}
            />
          ))}
          {runState === 'cancelling' && (
            <div className="run-note">cancelling</div>
          )}
          {compacting && (
            <div className="run-note">compacting context...</div>
          )}
        </div>
        <ConversationNav
          count={userIndexes.length}
          index={navIndex}
          onPrevious={() => goToUser(-1)}
          onNext={() => goToUser(1)}
        />
        {showJump && (
          <button
            type="button"
            className="button-primary jump-bottom"
            onClick={jumpToBottom}
            title="back to bottom"
          >
            [bottom]
          </button>
        )}
      </div>
      {runError && (
        <div className="error-banner" role="alert">
          <span className="marker">[!]</span>
          <span>{runError}</span>
          <button type="button" onClick={() => setRunError(null)} title="dismiss">[x]</button>
        </div>
      )}
      <div className="composer">
        <div className="permissions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={allowNetwork}
              onChange={event => setAllowNetwork(event.target.checked)}
              disabled={running || compacting}
            />
            <span className="toggle-mark">{allowNetwork ? '[x]' : '[ ]'}</span>
            <span>allowNetwork</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={allowShell}
              onChange={event => setAllowShell(event.target.checked)}
              disabled={running || compacting}
            />
            <span className="toggle-mark">{allowShell ? '[x]' : '[ ]'}</span>
            <span>allowShell</span>
          </label>
        </div>
        <textarea
          ref={composerRef}
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void startRun()
            }
          }}
          placeholder="prompt"
          rows={4}
          disabled={running || compacting}
          spellCheck={false}
        />
        <div className="composer-actions">
          {running ? (
            <button
              type="button"
              className="button-danger"
              onClick={cancelRun}
              disabled={runState !== 'running'}
            >
              [stop]
            </button>
          ) : (
            <button
              type="button"
              className="button-primary"
              onClick={() => void startRun()}
              disabled={!prompt.trim() || !apiKeySet || compacting}
            >
              [run]
            </button>
          )}
        </div>
      </div>
    </div>
  )

}

interface MessageBlockProps {
  message: DisplayMessage
  active?: boolean
  userRef?: Ref<HTMLDivElement>
  editing?: boolean
  editDraft?: string
  onEditDraftChange?: (value: string) => void
  onBeginEdit?: () => void
  onSubmitEdit?: () => void
  onCancelEdit?: () => void
  onForkAt?: () => void
}

function MessageBlock({
  message,
  active,
  userRef,
  editing = false,
  editDraft = '',
  onEditDraftChange,
  onBeginEdit,
  onSubmitEdit,
  onCancelEdit,
  onForkAt,
}: MessageBlockProps) {
  if (message.role === 'tool' && message.tool) {
    return <ToolBlock message={message} />
  }
  if (message.role === 'system' && message.compacted) {
    return <CompactionBlock message={message} />
  }
  if (message.role === 'system') {
    return (
      <div className="message system">
        <div className="message-label">[!]</div>
        <div className="message-body">{message.content}</div>
      </div>
    )
  }
  const marker = message.role === 'user' ? '>' : message.role === 'assistant' ? '<' : '-'
  const className = `message ${message.role}${active ? ' active-user' : ''}${editing ? ' editing' : ''}`
  const isUser = message.role === 'user'
  return (
    <div className={className} ref={userRef}>
      <div className="message-label">
        <span>
          {marker} {message.role}
          {message.pending ? ' ...' : ''}
          {message.finishReason ? ` / ${message.finishReason}` : ''}
        </span>
        {isUser && !editing && (onBeginEdit || onForkAt) && (
          <span className="message-menu">
            {onBeginEdit && (
              <button
                type="button"
                className="icon-button"
                onClick={onBeginEdit}
                title="edit"
              >
                [edit]
              </button>
            )}
            {onForkAt && (
              <button
                type="button"
                className="icon-button"
                onClick={onForkAt}
                title="fork here"
              >
                [fork]
              </button>
            )}
          </span>
        )}
      </div>
      {editing ? (
        <div className="message-edit">
          <textarea
            value={editDraft}
            onChange={event => onEditDraftChange?.(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                onSubmitEdit?.()
              }
              if (event.key === 'Escape') onCancelEdit?.()
            }}
            autoFocus
            spellCheck={false}
            rows={4}
          />
          <div className="message-edit-actions">
            <button
              type="button"
              className="button-primary"
              onClick={onSubmitEdit}
              disabled={!editDraft.trim()}
            >
              [send]
            </button>
            <button type="button" onClick={onCancelEdit} title="cancel">
              [x]
            </button>
          </div>
        </div>
      ) : (
        <div className="message-body md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}

function ContextRing({ context }: { context: ContextUsage }) {
  const ratio = Math.min(1, Math.max(0, context.ratio))
  const radius = 11
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - ratio)
  const color = ratio >= 0.8
    ? 'var(--danger)'
    : ratio >= 0.5
      ? 'var(--warning)'
      : 'var(--success)'
  const percent = Math.round(context.ratio * 100)
  return (
    <div
      className="context-ring"
      title={`${context.tokens.toLocaleString()} / ${context.limit.toLocaleString()} tokens`}
    >
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
        <circle
          className="context-ring-track"
          cx="17"
          cy="17"
          r={radius}
        />
        <circle
          className="context-ring-value"
          cx="17"
          cy="17"
          r={radius}
          stroke={color}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 17 17)"
        />
      </svg>
      <span className="context-ring-label">{percent}%</span>
    </div>
  )
}

function ToolBlock({ message }: { message: DisplayMessage }) {
  const [open, setOpen] = useState(false)
  const tool = message.tool!
  const marker = open ? '[-]' : '[+]'
  const status = tool.status === 'pending'
    ? 'run'
    : tool.ok
      ? 'ok'
      : 'err'
  return (
    <div className="message tool">
      <button type="button" className="tool-toggle" onClick={() => setOpen(open => !open)}>
        <span className="marker">{marker}</span>
        <span className="tool-status">{status}</span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-id">{tool.callId.slice(0, 8)}</span>
      </button>
      {open && (
        <div className="tool-detail">
          {tool.argumentsText && (
            <pre className="tool-arguments">{tool.argumentsText}</pre>
          )}
          {tool.status === 'done' && tool.ok && tool.outputText !== undefined && (
            <pre className="tool-output">{tool.outputText}</pre>
          )}
          {tool.status === 'done' && !tool.ok && (
            <pre className="tool-error">{tool.errorText ?? 'tool failed'}</pre>
          )}
          {tool.status === 'pending' && <div className="run-note">running</div>}
        </div>
      )}
    </div>
  )
}

function CompactionBlock({ message }: { message: DisplayMessage }) {
  const [open, setOpen] = useState(false)
  const tokens = message.tokensBefore
  const tokenText = tokens !== undefined
    ? `${tokens.toLocaleString()} tokens`
    : 'context'
  return (
    <div className="message compaction">
      <button
        type="button"
        className="compaction-toggle"
        onClick={() => setOpen(open => !open)}
      >
        <span className="marker">{open ? '[-]' : '[+]'}</span>
        <span className="compaction-status">[compaction]</span>
        <span className="compaction-meta">
          {open
            ? `compacted from ${tokenText}`
            : `compacted from ${tokenText} (expand)`}
        </span>
      </button>
      {open && message.content && (
        <div className="compaction-summary md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}

interface SettingsViewProps {
  config: ConfigSnapshot | null
  onSaved: (config: ConfigSnapshot) => void
}

function SettingsView({ config, onSaved }: SettingsViewProps) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [temperature, setTemperature] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!config) return
    setBaseUrl(config.config.baseUrl ?? config.effective.baseUrl)
    setModel(config.config.model ?? config.effective.model)
    setTemperature(
      config.config.temperature === undefined
        ? ''
        : String(config.config.temperature),
    )
  }, [config])

  async function submit() {
    if (!config || busy) return
    setBusy(true)
    setError(null)
    const patch: Record<string, unknown> = {}
    if (apiKey.trim()) patch.apiKey = apiKey.trim()
    if (baseUrl.trim()) patch.baseUrl = baseUrl.trim()
    else patch.baseUrl = ''
    if (model.trim()) patch.model = model.trim()
    else patch.model = ''
    if (temperature.trim()) {
      const value = Number(temperature)
      if (Number.isFinite(value)) patch.temperature = value
    }
    try {
      const next = await api.saveConfig(patch)
      onSaved(next)
      setApiKey('')
      setSaved(true)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings">
      <div className="settings-header">
        <span>[settings]</span>
        <span className="count">{config?.apiKeySet ? 'key set' : 'key not set'}</span>
      </div>
      <div className="settings-grid">
        <label className="field">
          <span>apiKey</span>
          <input
            type="password"
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
            placeholder={config?.apiKeySet ? '********' : 'not set'}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-note">
            {config?.apiKeySet ? '[set]' : '[not set]'}
          </span>
        </label>
        <label className="field">
          <span>baseUrl</span>
          <input
            type="text"
            value={baseUrl}
            onChange={event => setBaseUrl(event.target.value)}
            spellCheck={false}
          />
          <span className="field-note">env: {config?.env.baseUrl ?? 'none'}</span>
        </label>
        <label className="field">
          <span>model</span>
          <input
            type="text"
            value={model}
            onChange={event => setModel(event.target.value)}
            list="model-options"
            spellCheck={false}
          />
          <datalist id="model-options">
            {MODEL_OPTIONS.map(option => <option key={option} value={option} />)}
          </datalist>
          <span className="field-note">env: {config?.env.model ?? 'none'}</span>
        </label>
        <label className="field">
          <span>temperature</span>
          <input
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={temperature}
            onChange={event => setTemperature(event.target.value)}
            placeholder={config?.effective.temperature === undefined
              ? 'default'
              : String(config.effective.temperature)}
          />
          <span className="field-note">effective: {config?.effective.model ?? '-'}</span>
        </label>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <span className="marker">[!]</span>
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} title="dismiss">[x]</button>
        </div>
      )}
      <div className="settings-actions">
        <button type="button" className="button-primary" onClick={() => void submit()} disabled={busy}>
          [save]
        </button>
        {saved && <span className="saved-note">saved</span>}
      </div>
    </div>
  )
}

function projectEvents(events: SessionEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = []
  const toolIndex = new Map<string, number>()
  for (const event of events) {
    switch (event.type) {
      case 'message':
        if (
          event.payload.role === 'system'
          || event.payload.role === 'user'
          || event.payload.role === 'assistant'
        ) {
          if (event.payload.content) {
            messages.push({
              id: event.id,
              role: event.payload.role,
              content: event.payload.content,
            })
          }
        }
        break
      case 'tool-call':
        messages.push({
          id: event.id,
          role: 'tool',
          content: '',
          tool: {
            callId: event.payload.id,
            name: event.payload.name,
            argumentsText: prettyJson(event.payload.arguments),
            status: 'pending',
          },
        })
        toolIndex.set(event.payload.id, messages.length - 1)
        break
      case 'tool-result': {
        const index = toolIndex.get(event.payload.toolCallId)
        if (index === undefined) {
          messages.push({
            id: event.id,
            role: 'tool',
            content: '',
            tool: {
              callId: event.payload.toolCallId,
              name: event.payload.name,
              argumentsText: '',
              status: 'done',
              ok: event.payload.ok,
              outputText: event.payload.output === undefined
                ? undefined
                : prettyJson(event.payload.output),
              errorText: event.payload.error?.message,
            },
          })
        } else {
          const target = messages[index]
          if (target?.tool) {
            target.tool.status = 'done'
            target.tool.ok = event.payload.ok
            target.tool.outputText = event.payload.output === undefined
              ? undefined
              : prettyJson(event.payload.output)
            target.tool.errorText = event.payload.error?.message
          }
        }
        break
      }
      case 'checkpoint': {
        const snapshot = event.payload.snapshot
        if (snapshot?.length) {
          messages.push(...projectEvents(snapshot))
          messages.push({
            id: event.id,
            role: 'system',
            content: event.payload.summary ?? '',
            compacted: true,
            tokensBefore: event.payload.tokensBefore,
          })
        } else {
          for (const item of event.payload.messages) {
            pushModelMessage(messages, toolIndex, item, event.id)
          }
        }
        break
      }
      case 'meta':
        break
    }
  }
  return messages
}

function pushModelMessage(
  messages: DisplayMessage[],
  toolIndex: Map<string, number>,
  item: ModelMessage,
  sourceId: string,
): void {
  if (item.role === 'tool') {
    const index = toolIndex.get(item.tool_call_id ?? '')
    const legacyFailed = item.content.startsWith('error: ')
    const failed = item.toolOk === false
      || (item.toolOk === undefined && legacyFailed)
    const errorText = item.toolError?.message
      ?? (legacyFailed ? item.content.slice(7) : undefined)
    if (index !== undefined && messages[index]?.tool) {
      const target = messages[index]!.tool!
      target.status = 'done'
      target.ok = !failed
      target.errorText = errorText
      target.outputText = failed ? undefined : item.content
    } else {
      messages.push({
        id: `${sourceId}-${messages.length}`,
        role: 'tool',
        content: '',
        tool: {
          callId: item.tool_call_id ?? '',
          name: item.name ?? 'tool',
          argumentsText: '',
          status: 'done',
          ok: !failed,
          outputText: failed ? undefined : item.content,
          errorText,
        },
      })
    }
    return
  }
  if (item.role === 'system' || item.role === 'user' || item.role === 'assistant') {
    messages.push({
      id: `${sourceId}-${messages.length}`,
      role: item.role,
      content: item.content,
    })
    for (const call of item.tool_calls ?? []) {
      messages.push({
        id: `${sourceId}-tool-${call.id}`,
        role: 'tool',
        content: '',
        tool: {
          callId: call.id,
          name: call.name,
          argumentsText: prettyJson(call.arguments),
          status: 'pending',
        },
      })
      toolIndex.set(call.id, messages.length - 1)
    }
  }
}

function findPendingAssistant(messages: DisplayMessage[]): DisplayMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index]
    if (entry && entry.role === 'assistant' && entry.pending) return entry
  }
  return undefined
}

function lastAssistant(messages: DisplayMessage[]): DisplayMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index]
    if (entry && entry.role === 'assistant') return entry
  }
  return undefined
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return String(reason)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const api = {
  addWorkspace,
  removeWorkspace,
  listSessions,
  getSession,
  createSession,
  renameSession,
  forkSession,
  truncateSession,
  compactSession,
  deleteSession,
  saveConfig,
  stopRun,
  streamRun,
}
