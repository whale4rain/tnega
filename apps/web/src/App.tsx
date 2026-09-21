import { useCallback, useEffect, useState } from 'react'
import { Theme } from '@radix-ui/themes'
import { WorkbenchShell } from './workbench/WorkbenchShell'
import { WorkspaceSidebar } from './workbench/WorkspaceSidebar'
import { ChatView } from './conversation/ChatView'
import { SettingsView } from './workbench/SettingsView'
import type { ThemePreference } from './ThemeToggle'
import {
  clearSessionSelection,
  readSessionSelection,
  readWorkspaceSelection,
  resolveWorkspaceSelection,
  writeSessionSelection,
  writeWorkspaceSelection,
} from './sessionSelection'
import { latestPlanFromEvents, type DisplayPlan } from './planDisplay'
import { projectEvents } from './projectEvents'
import * as api from './api'
import type {
  ConfigSnapshot,
  ContextUsage,
  DisplayMessage,
  SessionSummary,
} from './types'

type View = 'chat' | 'settings'

const THEME_STORAGE_KEY = 'tnega-theme'

function initialThemePreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored
  }
  return 'dark'
}

function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference === 'light' || preference === 'dark') return preference
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export default function App() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    initialThemePreference,
  )
  const [appearance, setAppearance] = useState(() =>
    resolveTheme(themePreference),
  )
  const [config, setConfig] = useState<ConfigSnapshot | null>(null)
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [workspace, setWorkspace] = useState<string | null>(() =>
    readWorkspaceSelection(localStorage),
  )
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [context, setContext] = useState<ContextUsage | null>(null)
  const [sessionRunning, setSessionRunning] = useState(false)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [plan, setPlan] = useState<DisplayPlan | undefined>(undefined)
  const [view, setView] = useState<View>('chat')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolveTheme(themePreference)
    setAppearance(resolveTheme(themePreference))
    localStorage.setItem(THEME_STORAGE_KEY, themePreference)
    if (themePreference !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = () => {
      root.dataset.theme = resolveTheme('system')
      setAppearance(resolveTheme('system'))
    }
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [themePreference])

  useEffect(() => {
    let cancelled = false
    void Promise.all([api.getConfig(), api.listWorkspaces()])
      .then(([nextConfig, nextWorkspaces]) => {
        if (cancelled) return
        setConfig(nextConfig)
        const stored = nextWorkspaces.workspaces
        setWorkspaces(stored)
        setWorkspace(resolveWorkspaceSelection(localStorage, stored))
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
    api
      .listSessions(workspace)
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

  const selectSession = useCallback(
    (id: string) => {
      if (!workspace) return
      setSessionId(id)
      setError(null)
      setMessages([])
      api
        .getSession(workspace, id)
        .then((detail) => {
          setSummary(detail.summary)
          setContext(detail.context)
          setSessionRunning(detail.running)
          setMessages(projectEvents(detail.events))
          setPlan(latestPlanFromEvents(detail.events))
        })
        .catch((reason: unknown) => setError(messageOf(reason)))
    },
    [workspace],
  )

  useEffect(() => {
    if (workspace) writeWorkspaceSelection(localStorage, workspace)
  }, [workspace])

  useEffect(() => {
    if (!workspace || !sessionId) return
    writeSessionSelection(localStorage, workspace, sessionId)
  }, [workspace, sessionId])

  useEffect(() => {
    if (!workspace || !sessions.length) return
    const preferred = readSessionSelection(localStorage, workspace)
    if (!preferred || sessionId === preferred) return
    if (!sessions.some((session) => session.id === preferred)) {
      clearSessionSelection(localStorage, workspace)
      return
    }
    selectSession(preferred)
  }, [sessions, workspace, sessionId, selectSession])

  const selectWorkspace = useCallback(
    (next: string) => {
      if (next === workspace) return
      setWorkspace(next)
      setSessionId(null)
      setSummary(null)
      setContext(null)
      setSessionRunning(false)
      setMessages([])
    },
    [workspace],
  )

  const refreshSession = useCallback(
    async (id: string) => {
      if (!workspace) return
      const detail = await api.getSession(workspace, id)
      setSummary(detail.summary)
      setContext(detail.context)
      setSessionRunning(detail.running)
      setMessages(projectEvents(detail.events))
      setPlan(latestPlanFromEvents(detail.events))
      const next = await api.listSessions(workspace)
      setSessions(next.sessions)
      return detail
    },
    [workspace],
  )

  async function handleAddWorkspace(path: string) {
    if (!path.trim()) return
    try {
      const result = await api.addWorkspace(path.trim())
      setWorkspaces(result.workspaces)
      setSessions([])
      selectWorkspace(result.path)
    } catch (reason) {
      setError(messageOf(reason))
      throw reason
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
        setPlan(undefined)
      }
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleNewSession(
    options: {
      agentType?: 'general' | 'coding'
      mode?: 'auto' | 'plan' | 'execute'
    } = {},
  ) {
    if (!workspace) return
    try {
      const { session } = await api.createSession(workspace, options)
      setSessions((current) => [session, ...current])
      selectSession(session.id)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleRename(id: string, title: string) {
    if (!workspace || !title.trim()) return
    try {
      const { summary: next } = await api.renameSession(
        workspace,
        id,
        title.trim(),
      )
      setSessions((current) =>
        current.map((session) => (session.id === id ? next : session)),
      )
      if (sessionId === id) setSummary(next)
    } catch (reason) {
      setError(messageOf(reason))
      throw reason
    }
  }

  async function handleFork(id: string) {
    if (!workspace) return
    try {
      const { session } = await api.forkSession(workspace, id)
      setSessions((current) => [session, ...current])
      selectSession(session.id)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleForkAt(id: string, messageId: string) {
    if (!workspace) return
    try {
      const { session } = await api.forkSession(workspace, id, { messageId })
      setSessions((current) => [session, ...current])
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
      setSessions((current) => current.filter((session) => session.id !== id))
      if (sessionId === id) {
        setSessionId(null)
        setSummary(null)
        setContext(null)
        setSessionRunning(false)
        setMessages([])
        setPlan(undefined)
      }
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleModeChange(nextMode: 'auto' | 'plan' | 'execute') {
    if (!workspace || !sessionId) return
    try {
      const { summary: next } = await api.patchSessionMeta(
        workspace,
        sessionId,
        {
          mode: nextMode,
        },
      )
      setSummary(next)
      setSessions((current) =>
        current.map((session) => (session.id === sessionId ? next : session)),
      )
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleConfigSaved(next: ConfigSnapshot) {
    setConfig(next)
    setView('chat')
  }

  return (
    <Theme
      appearance={appearance}
      accentColor="gray"
      grayColor="gray"
      radius="large"
      scaling="100%"
    >
      <WorkbenchShell
        sidebar={
          <WorkspaceSidebar
            workspaces={workspaces}
            workspace={workspace}
            sessions={sessions}
            selectedId={sessionId}
            onWorkspace={selectWorkspace}
            onAdd={handleAddWorkspace}
            onRemove={handleRemoveWorkspace}
            onSelect={(id) => {
              setView('chat')
              selectSession(id)
            }}
            onNew={async (options) => {
              setView('chat')
              await handleNewSession(options)
            }}
            onRename={handleRename}
            onFork={handleFork}
            onDelete={handleDelete}
            onSettings={() =>
              setView((current) =>
                current === 'settings' ? 'chat' : 'settings',
              )
            }
            theme={themePreference}
            onTheme={setThemePreference}
          />
        }
      >
        {error && (
          <div className="error-banner" role="alert">
            <span className="marker">Error</span>
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              title="Dismiss"
            >
              Close
            </button>
          </div>
        )}
        {view === 'settings' ? (
          <SettingsView config={config} onSaved={handleConfigSaved} />
        ) : (
          <ChatView
            model={config?.effective.model}
            onSettings={() => setView('settings')}
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
            plan={plan}
            onPlanChange={setPlan}
            onModeChange={handleModeChange}
          />
        )}
      </WorkbenchShell>
    </Theme>
  )
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
