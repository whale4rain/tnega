import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, Theme } from '@radix-ui/themes'
import { WorkbenchShell } from './workbench/WorkbenchShell'
import { WorkspaceSidebar } from './workbench/WorkspaceSidebar'
import { ChatView } from './conversation/ChatView'
import { ProjectExperience } from './project/ProjectExperience'
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
import {
  readRecentProjects,
  rememberProject,
  forgetProject,
  type RecentProject,
} from './projectSelection'
import { projectEvents } from './projectEvents'
import * as api from './api'
import * as projectApi from './project/api'
import type {
  ConfigSnapshot,
  ContextUsage,
  SessionMetrics,
  DisplayMessage,
  SessionSummary,
} from './types'

const THEME_STORAGE_KEY = 'tnega-theme'
const LAST_VIEW_KEY = 'tnega-last-view'

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
  return <ChatApp />
}

function ChatApp() {
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
  const currentWorkspace = useRef(workspace)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(() => {
    const selectedWorkspace = readWorkspaceSelection(localStorage)
    return selectedWorkspace ? readSessionSelection(localStorage, selectedWorkspace) : null
  })
  const selection = useRef<{ workspace: string; id: string } | null>(null)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [context, setContext] = useState<ContextUsage | null>(null)
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null)
  const [sessionRunning, setSessionRunning] = useState(false)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [plan, setPlan] = useState<DisplayPlan | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Project 与 Session 是同一块主区的两种内容：选中谁就显示谁。
  const [project, setProject] = useState<{ workspace: string; id: string } | null>(null)
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(() =>
    readRecentProjects(localStorage))
  const projected = useRef<{ id: string; seq: number } | null>(null)
  const restoredSelection = useRef(false)

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
        const nextWorkspace = resolveWorkspaceSelection(localStorage, stored)
        if (nextWorkspace !== currentWorkspace.current) {
          selection.current = null
          setSessionId(null)
          setSummary(null)
          setMessages([])
          projected.current = null
        }
        currentWorkspace.current = nextWorkspace
        setWorkspace(nextWorkspace)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageOf(reason))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    for (const path of workspaces) {
      void api
        .listSessions(path)
        .then(({ sessions: next }) => {
          if (!cancelled)
            setSessions((current) => [
              ...current.filter((item) => item.workspace !== path),
              ...next,
            ])
        })
        .catch((reason: unknown) => {
          if (!cancelled) setError(`${path}: ${messageOf(reason)}`)
        })
    }
    return () => {
      cancelled = true
    }
  }, [workspaces])

  const selectSession = useCallback((path: string, id: string) => {
    const target = { workspace: path, id }
    setProject(null)
    localStorage.setItem(LAST_VIEW_KEY, 'sessions')
    selection.current = target
    currentWorkspace.current = path
    setWorkspace(path)
    setSessionId(id)
    writeWorkspaceSelection(localStorage, path)
    writeSessionSelection(localStorage, path, id)
    setError(null)
    setMessages([])
    projected.current = null
    setSummary(null)
    setContext(null)
    setMetrics(null)
    setSessionRunning(false)
    setPlan(undefined)
    api
      .getSession(path, id)
      .then((detail) => {
        if (selection.current !== target) return
        setSummary(detail.summary)
        setContext(detail.context)
        setMetrics(detail.metrics)
        setSessionRunning(detail.running)
        projected.current = { id, seq: detail.events.at(-1)?.seq ?? 0 }
        setMessages(projectEvents(detail.events))
        setPlan(latestPlanFromEvents(detail.events))
      })
      .catch((reason: unknown) => {
        if (selection.current === target) setError(messageOf(reason))
      })
  }, [])

  const openProject = useCallback((next: RecentProject) => {
    setProject({ workspace: next.workspace, id: next.id })
    setRecentProjects(rememberProject(localStorage, next))
    localStorage.setItem(LAST_VIEW_KEY, 'projects')
  }, [])

  async function handleCreateProject(input: { name: string; folder: string; goal?: string }) {
    try {
      const { project: created } = await projectApi.createProject(input.folder, {
        name: input.name,
        ...(input.goal ? { goal: input.goal } : {}),
      })
      openProject({
        workspace: input.folder,
        id: created.id,
        name: created.name,
        openedAt: Date.now(),
      })
    } catch (reason) {
      setError(messageOf(reason))
      throw reason
    }
  }

  function handleForgetProject(id: string) {
    setRecentProjects(forgetProject(localStorage, id))
    setProject(current => (current?.id === id ? null : current))
  }

  useEffect(() => {
    const refreshConfig = () => { void api.getConfig().then(setConfig).catch(reason => setError(messageOf(reason))) }
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'tnega-config-revision') refreshConfig()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', refreshConfig)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', refreshConfig)
    }
  }, [])

  useEffect(() => {
    if (restoredSelection.current) return
    restoredSelection.current = true
    if (localStorage.getItem(LAST_VIEW_KEY) === 'projects') {
      const [last] = readRecentProjects(localStorage)
      if (last) {
        openProject(last)
        return
      }
    }
    if (!workspace || !sessionId) return
    selectSession(workspace, sessionId)
  }, [workspace, sessionId, selectSession, openProject])

  useEffect(() => {
    if (workspace) writeWorkspaceSelection(localStorage, workspace)
  }, [workspace])

  useEffect(() => {
    if (!workspace || sessionId) return
    const available = sessions.filter(
      (session) => session.workspace === workspace,
    )
    if (!available.length) return
    const preferred = readSessionSelection(localStorage, workspace)
    if (!preferred || sessionId === preferred) return
    if (!available.some((session) => session.id === preferred)) {
      clearSessionSelection(localStorage, workspace)
      return
    }
    selectSession(workspace, preferred)
  }, [sessions, workspace, sessionId, selectSession])

  const selectWorkspace = useCallback(
    (next: string) => {
      if (next === workspace) return
      setProject(null)
      selection.current = null
      currentWorkspace.current = next
      setWorkspace(next)
      setSessionId(null)
      setSummary(null)
      setContext(null)
      setMetrics(null)
      setSessionRunning(false)
      setMessages([])
      projected.current = null
      setPlan(undefined)
    },
    [workspace],
  )

  const refreshSession = useCallback(
    async (id: string, refreshList = true) => {
      if (!workspace) return
      const target = selection.current
      if (target?.workspace !== workspace || target.id !== id) return
      const detail = await api.getSession(workspace, id)
      if (selection.current !== target) return detail
      setSummary(current => sameValue(current, detail.summary) ? current : detail.summary)
      setContext(current => sameValue(current, detail.context) ? current : detail.context)
      setMetrics(current => sameValue(current, detail.metrics) ? current : detail.metrics)
      setSessionRunning(detail.running)
      const seq = detail.events.at(-1)?.seq ?? 0
      if (projected.current?.id !== id || projected.current.seq !== seq) {
        projected.current = { id, seq }
        setMessages(projectEvents(detail.events))
        setPlan(latestPlanFromEvents(detail.events))
      }
      if (refreshList) {
        const next = await api.listSessions(workspace)
        setSessions((current) => [
          ...current.filter((item) => item.workspace !== workspace),
          ...next.sessions,
        ])
      }
      return detail
    },
    [workspace],
  )

  async function handleAddWorkspace(path: string) {
    if (!path.trim()) return
    try {
      const result = await api.addWorkspace(path.trim())
      setWorkspaces(result.workspaces)
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
      setSessions((current) =>
        current.filter((session) => session.workspace !== path),
      )
      clearSessionSelection(localStorage, path)
      if (currentWorkspace.current === path) {
        selection.current = null
        currentWorkspace.current = null
        setWorkspace(null)
        setSessionId(null)
        setSummary(null)
        setContext(null)
        setSessionRunning(false)
        setMessages([])
        projected.current = null
        setPlan(undefined)
      }
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleNewSession(
    options: {
      agentType?: 'general' | 'coding'
      mode?: 'auto' | 'plan' | 'goal'
    } = {},
    targetWorkspace = workspace,
  ) {
    if (!targetWorkspace) return
    try {
      const { session } = await api.createSession(targetWorkspace, options)
      setSessions((current) => [session, ...current])
      selectSession(targetWorkspace, session.id)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleRename(path: string, id: string, title: string) {
    if (!title.trim()) return
    try {
      const { summary: next } = await api.renameSession(path, id, title.trim())
      setSessions((current) =>
        current.map((session) =>
          session.workspace === path && session.id === id ? next : session,
        ),
      )
      if (selection.current?.workspace === path && selection.current.id === id)
        setSummary(next)
    } catch (reason) {
      setError(messageOf(reason))
      throw reason
    }
  }

  async function handleFork(path: string, id: string) {
    try {
      const { session } = await api.forkSession(path, id)
      setSessions((current) => [session, ...current])
      selectSession(path, session.id)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleForkAt(id: string, messageId: string) {
    if (!workspace) return
    try {
      const { session } = await api.forkSession(workspace, id, { messageId })
      setSessions((current) => [session, ...current])
      selectSession(workspace, session.id)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleDelete(path: string, id: string) {
    try {
      await api.deleteSession(path, id)
      setSessions((current) =>
        current.filter(
          (session) => session.workspace !== path || session.id !== id,
        ),
      )
      if (readSessionSelection(localStorage, path) === id)
        clearSessionSelection(localStorage, path)
      if (
        selection.current?.workspace === path &&
        selection.current.id === id
      ) {
        selection.current = null
        setSessionId(null)
        setSummary(null)
        setContext(null)
        setSessionRunning(false)
        setMessages([])
        projected.current = null
        setPlan(undefined)
      }
    } catch (reason) {
      setError(messageOf(reason))
      throw reason
    }
  }

  async function handleModeChange(nextMode: 'auto' | 'plan' | 'goal') {
    if (!workspace || !sessionId) return
    try {
      const { summary: next } = await api.patchSessionMeta(
        workspace,
        sessionId,
        {
          mode: nextMode,
        },
      )
      if (
        selection.current?.workspace === workspace &&
        selection.current.id === sessionId
      )
        setSummary(next)
      setSessions((current) =>
        current.map((session) =>
          session.workspace === workspace && session.id === sessionId
            ? next
            : session,
        ),
      )
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleModelChange(model: string) {
    if (!workspace || !sessionId) return
    try {
      const { summary: next } = await api.patchSessionMeta(workspace, sessionId, {
        model,
        reasoningEffort: 'default',
      })
      if (selection.current?.workspace === workspace && selection.current.id === sessionId) setSummary(next)
      setSessions(current => current.map(item => item.workspace === workspace && item.id === sessionId ? next : item))
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  async function handleReasoningEffortChange(reasoningEffort: 'default' | 'low' | 'medium' | 'high') {
    if (!workspace || !sessionId) return
    try {
      const { summary: next } = await api.patchSessionMeta(workspace, sessionId, { reasoningEffort })
      if (selection.current?.workspace === workspace && selection.current.id === sessionId) setSummary(next)
      setSessions(current => current.map(item => item.workspace === workspace && item.id === sessionId ? next : item))
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const currentModelId = summary?.model ?? config?.effective.modelId
  const modelApiKeySet = config?.models.find(item => item.id === currentModelId)?.apiKeySet
    ?? config?.apiKeySet ?? false

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
            projects={recentProjects}
            selectedProjectId={project?.id ?? null}
            onOpenProject={openProject}
            onCreateProject={handleCreateProject}
            onForgetProject={handleForgetProject}
            onAdd={handleAddWorkspace}
            onRemove={handleRemoveWorkspace}
            onSelect={(path, id) => {
              selectSession(path, id)
            }}
            onNew={async (options, path) => {
              await handleNewSession(options, path)
            }}
            onRename={handleRename}
            onFork={handleFork}
            onDelete={handleDelete}
            onSettings={() => setSettingsOpen(true)}
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
        {project ? (
          <ProjectExperience workspace={project.workspace} projectId={project.id} />
        ) : (
          <ChatView
            model={currentModelId}
            models={config?.models ?? []}
            reasoningEffort={summary?.reasoningEffort ?? config?.effective.reasoningEffort ?? 'default'}
            onModelChange={handleModelChange}
            onReasoningEffortChange={handleReasoningEffortChange}
            onSettings={() => setSettingsOpen(true)}
            workspace={workspace}
            sessionId={sessionId}
            summary={summary}
            context={context}
            metrics={metrics}
            sessionRunning={sessionRunning}
            messages={messages}
            apiKeySet={modelApiKeySet}
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
      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Dialog.Content className="settings-dialog" maxWidth="680px" aria-describedby={undefined}>
          <Dialog.Title>Settings</Dialog.Title>
          <SettingsView config={config} onReload={setConfig} onSaved={next => {
            setConfig(next)
            setSettingsOpen(false)
          }} />
        </Dialog.Content>
      </Dialog.Root>
    </Theme>
  )
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function sameValue(left: object | null, right: object): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right)
}
