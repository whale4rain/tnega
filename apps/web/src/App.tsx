import { FolderKanban, FolderPlus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Conversation } from './components/Conversation'
import type { RunSettings } from './components/Composer'
import { NewProjectDialog } from './components/project/NewProjectDialog'
import { ProjectView } from './components/project/ProjectView'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { SubagentDrawer } from './components/SubagentDrawer'
import { WorkspaceDialog } from './components/WorkspaceDialog'
import { api } from './lib/api'
import { errorText, useStoredState, useTheme } from './lib/hooks'
import { projectApi } from './lib/project-api'
import type { ProjectRecord } from './lib/project-types'
import type { AgentType, ApprovalMode, ConfigSnapshot, Permission, SessionSummary } from './lib/types'

type Mode = 'sessions' | 'projects'

interface ProjectRoute {
  id?: string
  threadId?: string
}

function sessionFromHash(): string | undefined {
  const id = location.hash.replace(/^#\/?/, '')
  return /^[\w-]{6,}$/.test(id) ? id : undefined
}

/** `#p/<project>` or `#p/<project>/<thread>`. */
function projectFromHash(): ProjectRoute | undefined {
  const match = location.hash.match(/^#\/?p\/([\w-]+)(?:\/([\w-]+))?$/)
  if (!match) return undefined
  return { id: match[1]!, ...(match[2] ? { threadId: match[2] } : {}) }
}

function setHash(hash: string): void {
  if (location.hash !== hash && !(hash === '' && location.hash === '')) {
    history.replaceState(null, '', `${location.pathname}${location.search}${hash}`)
  }
}

export function App() {
  const [theme, setTheme] = useTheme()
  const [config, setConfig] = useState<ConfigSnapshot | undefined>()
  const [workspaces, setWorkspaces] = useState<string[] | undefined>()
  const [workspace, setWorkspace] = useStoredState<string>('tnega.workspace', '')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | undefined>(sessionFromHash)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 860)
  const [dialog, setDialog] = useState<'settings' | 'workspace' | undefined>()
  const [subagent, setSubagent] = useState<{ id: string; label: string } | undefined>()
  const [fatal, setFatal] = useState<string | undefined>()
  const [mode, setMode] = useStoredState<Mode>('tnega.mode', projectFromHash() ? 'projects' : 'sessions', ['sessions', 'projects'])
  const [projectRoute, setProjectRoute] = useState<ProjectRoute>(() => projectFromHash() ?? {})
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [newProject, setNewProject] = useState(false)

  const [agentType, setAgentType] = useStoredState<AgentType>('tnega.agentType', 'coding', ['coding', 'work', 'general'])
  const [permission, setPermission] = useStoredState<Permission>('tnega.permission', 'read-only', ['read-only', 'workspace-write', 'bypass'])
  const [approvalPreference, setApprovalMode] = useStoredState<ApprovalMode | 'default'>('tnega.approvalMode', 'default', ['manual', 'auto', 'default'])
  const approvalMode = approvalPreference === 'default' ? config?.config.approvalReview?.defaultMode ?? 'manual' : approvalPreference
  const [draftExtras, setDraftExtras] = useState<Pick<RunSettings, 'mode' | 'model' | 'reasoningEffort'>>({ mode: 'auto', reasoningEffort: 'default' })
  const draftSettings: RunSettings = { agentType, permission, approvalMode, ...draftExtras }
  const updateDraft = (patch: Partial<RunSettings>) => {
    if (patch.agentType) setAgentType(patch.agentType)
    if (patch.permission) setPermission(patch.permission)
    if (patch.approvalMode) setApprovalMode(patch.approvalMode)
    const extras: Partial<RunSettings> = {}
    if (patch.mode) extras.mode = patch.mode
    if (patch.reasoningEffort) extras.reasoningEffort = patch.reasoningEffort
    if ('model' in patch) extras.model = patch.model
    if (Object.keys(extras).length) setDraftExtras(current => ({ ...current, ...extras }))
  }

  // --- bootstrapping -------------------------------------------------------

  useEffect(() => {
    api.config().then(setConfig, reason => setFatal(errorText(reason)))
    api.workspaces().then(result => {
      setWorkspaces(result.workspaces)
      if (!result.workspaces.includes(workspace)) setWorkspace(result.workspaces[0] ?? '')
    }, reason => setFatal(errorText(reason)))
    // `workspace` is only consulted once, to validate the stored choice.
  }, [])

  const refreshSessions = useCallback(() => {
    if (!workspace) return
    api.sessions(workspace).then(result => setSessions(result.sessions), () => {})
  }, [workspace])

  useEffect(() => {
    setSessions([])
    if (!workspace) return
    setSessionsLoading(true)
    let cancelled = false
    api.sessions(workspace)
      .then(result => {
        if (cancelled) return
        setSessions(result.sessions)
        // A linked session from another workspace can't be opened here.
        const linked = sessionFromHash()
        if (linked && !result.sessions.some(s => s.id === linked)) {
          setSelectedId(undefined)
          history.replaceState(null, '', `${location.pathname}${location.search}`)
        }
      }, reason => !cancelled && setFatal(errorText(reason)))
      .finally(() => !cancelled && setSessionsLoading(false))
    return () => {
      cancelled = true
    }
  }, [workspace])

  const refreshProjects = useCallback(() => {
    if (!workspace) return
    projectApi.list(workspace).then(result => setProjects(result.projects), () => {})
  }, [workspace])

  useEffect(() => {
    setProjects([])
    if (!workspace || mode !== 'projects') return
    setProjectsLoading(true)
    let cancelled = false
    projectApi.list(workspace)
      .then(result => !cancelled && setProjects(result.projects), () => {})
      .finally(() => !cancelled && setProjectsLoading(false))
    return () => {
      cancelled = true
    }
  }, [workspace, mode])

  // --- selection mirrors the URL hash so sessions and projects are linkable --

  const select = useCallback((id: string | undefined) => {
    setMode('sessions')
    setSelectedId(id)
    setSubagent(undefined)
    setHash(id ? `#${id}` : '')
    if (window.innerWidth <= 860) setSidebarOpen(false)
  }, [setMode])

  const openProject = useCallback((id: string | undefined, threadId?: string) => {
    setMode('projects')
    setSubagent(undefined)
    setProjectRoute({ ...(id ? { id } : {}), ...(threadId ? { threadId } : {}) })
    setHash(id ? `#p/${id}${threadId ? `/${threadId}` : ''}` : '')
    if (window.innerWidth <= 860) setSidebarOpen(false)
  }, [setMode])

  const changeMode = (next: Mode) => {
    if (next === mode) return
    if (next === 'projects') openProject(projectRoute.id)
    else select(selectedId)
  }

  useEffect(() => {
    const onHash = () => {
      const project = projectFromHash()
      if (project) {
        setMode('projects')
        setProjectRoute(project)
      } else {
        setSelectedId(sessionFromHash())
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [setMode])

  // --- keyboard -------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        if (mode === 'projects') setNewProject(true)
        else select(undefined)
      } else if (mod && !event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setSidebarOpen(open => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [select, mode])

  // --- actions ---------------------------------------------------------------

  const chooseWorkspace = (path: string) => {
    if (path === workspace) return
    setWorkspace(path)
    if (mode === 'projects') openProject(undefined)
    else select(undefined)
  }

  const removeWorkspace = async (path: string) => {
    try {
      const result = await api.removeWorkspace(path)
      setWorkspaces(result.workspaces)
      if (path === workspace) {
        setWorkspace(result.workspaces[0] ?? '')
        select(undefined)
      }
    } catch (reason) {
      alert(errorText(reason))
    }
  }

  const forkSession = async (id: string) => {
    try {
      const { session } = await api.forkSession(workspace, id)
      setSessions(list => [session, ...list])
      select(session.id)
    } catch (reason) {
      alert(errorText(reason))
    }
  }

  const deleteSession = async (session: SessionSummary) => {
    if (!confirm(`Delete “${session.title || 'Untitled session'}”? This can't be undone.`)) return
    try {
      await api.deleteSession(workspace, session.id)
      setSessions(list => list.filter(s => s.id !== session.id))
      if (session.id === selectedId) select(undefined)
    } catch (reason) {
      alert(errorText(reason))
    }
  }

  // --- render -----------------------------------------------------------------

  if (fatal && !workspaces) {
    return (
      <div className="splash">
        <span className="brand-mark large" aria-hidden />
        <h1>Can't reach the tnega server</h1>
        <p className="muted">{fatal}</p>
        <p className="muted small">Start it with <code>pnpm tnega web</code>, then reload this page.</p>
        <button type="button" className="button primary" onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }

  if (!workspaces) {
    return <div className="splash"><span className="brand-mark large pulse" aria-hidden /></div>
  }

  return (
    <div className={`app${sidebarOpen ? ' sidebar-open' : ' sidebar-closed'}${subagent ? ' drawer-open' : ''}`}>
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
      {sidebarOpen && (
        <Sidebar
          workspaces={workspaces}
          workspace={workspace || undefined}
          onSelectWorkspace={chooseWorkspace}
          onAddWorkspace={() => setDialog('workspace')}
          onRemoveWorkspace={path => void removeWorkspace(path)}
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          selectedId={selectedId}
          onSelectSession={select}
          onNewSession={() => select(undefined)}
          onForkSession={id => void forkSession(id)}
          onDeleteSession={session => void deleteSession(session)}
          onOpenSettings={() => setDialog('settings')}
          theme={theme}
          onThemeChange={setTheme}
          onCollapse={() => setSidebarOpen(false)}
          mode={mode}
          onModeChange={changeMode}
          projects={projects}
          projectsLoading={projectsLoading}
          selectedProjectId={projectRoute.id}
          onSelectProject={id => openProject(id)}
          onNewProject={() => setNewProject(true)}
        />
      )}

      {workspace && mode === 'projects' && (projectRoute.id
        ? (
          <ProjectView
            key={projectRoute.id}
            workspace={workspace}
            projectId={projectRoute.id}
            threadId={projectRoute.threadId}
            config={config}
            onOpenThread={threadId => openProject(projectRoute.id, threadId)}
            onDeleted={() => {
              setProjects(list => list.filter(p => p.id !== projectRoute.id))
              openProject(undefined)
            }}
            onChanged={refreshProjects}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen(open => !open)}
          />
        )
        : (
          <main className="welcome">
            <span className="welcome-icon"><FolderKanban size={26} /></span>
            <h1>Projects</h1>
            <p>Describe an outcome once. A coordinator splits it into parallel threads that share memory and a library, and reports back in one conversation.</p>
            <button type="button" className="button primary large" onClick={() => setNewProject(true)}>
              <FolderPlus size={17} /> New project
            </button>
          </main>
        ))}

      {mode === 'projects' && workspace ? null : workspace
        ? (
          <Conversation
            workspace={workspace}
            sessionId={selectedId}
            config={config}
            draftSettings={draftSettings}
            onDraftSettingsChange={updateDraft}
            onSessionCreated={session => {
              setSessions(list => [session, ...list.filter(s => s.id !== session.id)])
              select(session.id)
            }}
            onSessionsChanged={refreshSessions}
            onSessionDeleted={id => {
              setSessions(list => list.filter(s => s.id !== id))
              select(undefined)
            }}
            onOpenSettings={() => setDialog('settings')}
            onOpenSubagent={(id, label) => setSubagent({ id, label })}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen(open => !open)}
          />
        )
        : (
          <main className="welcome">
            <span className="brand-mark large" aria-hidden />
            <h1>Welcome to tnega</h1>
            <p>Pick a folder for the agent to work in. You can switch between workspaces at any time.</p>
            <button type="button" className="button primary large" onClick={() => setDialog('workspace')}>
              <FolderPlus size={17} /> Open a folder
            </button>
          </main>
        )}

      {subagent && workspace && (
        <SubagentDrawer
          workspace={workspace}
          id={subagent.id}
          label={subagent.label}
          onClose={() => setSubagent(undefined)}
          onOpenSubagent={(id, label) => setSubagent({ id, label })}
        />
      )}

      {newProject && workspace && (
        <NewProjectDialog
          workspace={workspace}
          onClose={() => setNewProject(false)}
          onCreated={project => {
            setProjects(list => [project, ...list])
            openProject(project.id)
          }}
        />
      )}
      {dialog === 'settings' &&<SettingsDialog config={config} onClose={() => setDialog(undefined)} onSaved={setConfig} />}
      {dialog === 'workspace' && (
        <WorkspaceDialog
          onClose={() => setDialog(undefined)}
          onAdded={(path, all) => {
            setWorkspaces(all)
            chooseWorkspace(path)
          }}
        />
      )}
    </div>
  )
}
