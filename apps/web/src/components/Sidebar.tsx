import {
  Briefcase,
  ChevronRight,
  Code2,
  FolderKanban,
  FolderPlus,
  GitBranch,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Search,
  Settings,
  SquarePen,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { folderName, relativeTime, type ThemePreference } from '../lib/hooks'
import { projectApi } from '../lib/project-api'
import type { ProjectRecord } from '../lib/project-types'
import type { SessionSummary } from '../lib/types'
import { Menu } from './Menu'
import { UpdateButton } from './UpdateButton'
import type { DesktopUpdates } from '../lib/desktop-updates'

/** Sessions shown per workspace before "N more". */
const VISIBLE_SESSIONS = 8
const COLLAPSED_KEY = 'tnega.sidebar.collapsed'

interface WorkspaceLists {
  sessions: SessionSummary[]
  projects: ProjectRecord[]
  loading: boolean
}

function readCollapsed(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * The sidebar is organised by workspace: each workspace is a collapsible group
 * holding its projects first, then its sessions by recency. The current
 * workspace's lists come from the app (they stay live); other expanded
 * workspaces load their own lists when opened.
 */
export function Sidebar({
  workspaces,
  workspace,
  onAddWorkspace,
  onRemoveWorkspace,
  sessions,
  sessionsLoading,
  projects,
  projectsLoading,
  mode,
  selectedId,
  selectedProjectId,
  onSelectSession,
  onSelectProject,
  onNewSession,
  onNewProject,
  onForkSession,
  onDeleteSession,
  onOpenSettings,
  theme,
  onThemeChange,
  onCollapse,
  updates,
}: {
  workspaces: string[]
  workspace: string | undefined
  onAddWorkspace: () => void
  onRemoveWorkspace: (path: string) => void
  sessions: SessionSummary[]
  sessionsLoading: boolean
  projects: ProjectRecord[]
  projectsLoading: boolean
  mode: 'sessions' | 'projects'
  selectedId: string | undefined
  selectedProjectId: string | undefined
  onSelectSession: (workspace: string, id: string) => void
  onSelectProject: (workspace: string, id: string) => void
  onNewSession: (workspace: string) => void
  onNewProject: (workspace: string) => void
  onForkSession: (workspace: string, id: string) => void
  /** Resolves true when the session was deleted. */
  onDeleteSession: (workspace: string, session: SessionSummary) => Promise<boolean>
  onOpenSettings: () => void
  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void
  onCollapse: () => void
  /** Desktop self-update; absent in the browser. */
  updates?: DesktopUpdates | undefined
}) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [others, setOthers] = useState<Record<string, WorkspaceLists>>({})

  const toggle = (path: string) => setCollapsed(current => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
    } catch { /* storage is optional */ }
    return next
  })

  const load = (path: string) => {
    setOthers(current => ({ ...current, [path]: { sessions: current[path]?.sessions ?? [], projects: current[path]?.projects ?? [], loading: true } }))
    void Promise.all([
      api.sessions(path).then(result => result.sessions, () => []),
      projectApi.list(path).then(result => result.projects, () => []),
    ]).then(([loadedSessions, loadedProjects]) => {
      setOthers(current => ({ ...current, [path]: { sessions: loadedSessions, projects: loadedProjects, loading: false } }))
    })
  }

  // The workspace being left was shown from the app's live lists; drop any older copy so it reloads.
  const [shown, setShown] = useState(workspace)
  if (shown !== workspace) {
    setShown(workspace)
    if (shown && others[shown]) {
      const rest = { ...others }
      delete rest[shown]
      setOthers(rest)
    }
  }

  // Load each other expanded workspace once; reopening the sidebar refreshes them.
  const pending = workspaces.filter(path => path !== workspace && !collapsed.has(path) && !others[path])
  useEffect(() => {
    for (const path of pending) load(path)
  }, [pending.join('\n')])

  const listsFor = (path: string): WorkspaceLists => path === workspace
    ? { sessions, projects, loading: sessionsLoading || projectsLoading }
    : others[path] ?? { sessions: [], projects: [], loading: false }

  const q = query.trim().toLowerCase()

  return (
    <aside className="sidebar" aria-label="Workspaces">
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">tnega</span>
        </div>
        <span className="sidebar-top-actions">
          <button type="button" className="icon-button" onClick={() => workspace && onNewSession(workspace)} disabled={!workspace} aria-label="New session" title="New session (Ctrl+Shift+O)">
            <SquarePen size={14} />
          </button>
          <button type="button" className="icon-button" onClick={onCollapse} aria-label="Hide sidebar" title="Hide sidebar (Ctrl+B)">
            <PanelLeftClose size={14} />
          </button>
        </span>
      </div>

      <label className="sidebar-search">
        <Search size={12} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search" aria-label="Search sessions and projects" />
        {query && (
          <button type="button" className="icon-button tiny" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>
        )}
      </label>

      <nav className="session-list workspace-tree">
        {workspaces.length === 0 && <p className="sidebar-empty">Open a folder to start working in it.</p>}
        {workspaces.map(path => (
          <WorkspaceGroup
            key={path}
            path={path}
            current={path === workspace}
            open={!collapsed.has(path) || Boolean(q)}
            lists={listsFor(path)}
            query={q}
            selectedSession={path === workspace && mode === 'sessions' ? selectedId : undefined}
            selectedProject={path === workspace && mode === 'projects' ? selectedProjectId : undefined}
            onToggle={() => toggle(path)}
            onSelectSession={id => onSelectSession(path, id)}
            onSelectProject={id => onSelectProject(path, id)}
            onNewSession={() => onNewSession(path)}
            onNewProject={() => onNewProject(path)}
            onFork={id => onForkSession(path, id)}
            onDelete={session => void onDeleteSession(path, session).then(deleted => {
              if (deleted && path !== workspace) load(path)
            })}
            onRemove={() => onRemoveWorkspace(path)}
          />
        ))}
      </nav>

      <div className="sidebar-footer">
        <button type="button" className="sidebar-footer-button icon-only" onClick={onOpenSettings} aria-label="Settings" title="Settings">
          <Settings size={14} />
        </button>
        <button type="button" className="sidebar-footer-button icon-only" onClick={onAddWorkspace} aria-label="Add workspace" title="Add workspace: open a folder">
          <FolderPlus size={14} />
        </button>
        <UpdateButton updates={updates} />
        <ThemeSwitch value={theme} onChange={onThemeChange} />
      </div>
    </aside>
  )
}

function WorkspaceGroup({
  path,
  current,
  open,
  lists,
  query,
  selectedSession,
  selectedProject,
  onToggle,
  onSelectSession,
  onSelectProject,
  onNewSession,
  onNewProject,
  onFork,
  onDelete,
  onRemove,
}: {
  path: string
  current: boolean
  open: boolean
  lists: WorkspaceLists
  query: string
  selectedSession: string | undefined
  selectedProject: string | undefined
  onToggle: () => void
  onSelectSession: (id: string) => void
  onSelectProject: (id: string) => void
  onNewSession: () => void
  onNewProject: () => void
  onFork: (id: string) => void
  onDelete: (session: SessionSummary) => void
  onRemove: () => void
}) {
  const [showAll, setShowAll] = useState(false)
  const name = folderName(path)
  const matching = useMemo(() => lists.projects
    .filter(project => !query || project.name.toLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt), [lists.projects, query])
  // Archived projects stay reachable behind "N more", after the live ones.
  const archived = matching.filter(project => project.archived && project.id !== selectedProject)
  const projects = showAll || query ? [...matching.filter(p => !archived.includes(p)), ...archived] : matching.filter(p => !archived.includes(p))
  const sessions = useMemo(() => lists.sessions
    .filter(session => !query || (session.title || 'untitled').toLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt), [lists.sessions, query])
  // Keep the open session visible even when it is older than the first few.
  const selectedIndex = selectedSession ? sessions.findIndex(session => session.id === selectedSession) : -1
  const limit = showAll || query ? sessions.length : Math.max(VISIBLE_SESSIONS, selectedIndex + 1)
  const hidden = Math.max(0, sessions.length - limit) + (showAll || query ? 0 : archived.length)
  if (query && projects.length === 0 && sessions.length === 0) return null

  return (
    <section className={`workspace-group${open ? ' open' : ''}${current ? ' current' : ''}`}>
      <div className="workspace-head">
        <button type="button" className="workspace-toggle" onClick={onToggle} aria-expanded={open} title={path}>
          <ChevronRight size={12} className="workspace-chevron" aria-hidden />
          <span className="workspace-name">{name}</span>
          {!open && lists.sessions.length > 0 && <span className="workspace-count">{lists.sessions.length}</span>}
        </button>
        <span className="workspace-actions">
          <button type="button" className="icon-button tiny" onClick={onNewProject} aria-label={`New project in ${name}`} title="New project">
            <FolderKanban size={12} />
          </button>
          <button type="button" className="icon-button tiny" onClick={onNewSession} aria-label={`New session in ${name}`} title="New session">
            <SquarePen size={12} />
          </button>
          <Menu
            label={`${name} options`}
            align="end"
            className="icon-button tiny"
            trigger={<MoreHorizontal size={12} />}
            items={[{ key: 'remove', label: 'Remove from list', icon: <X size={14} />, onSelect: onRemove }]}
          />
        </span>
      </div>

      {open && (
        <div className="workspace-items">
          {lists.loading && sessions.length === 0 && projects.length === 0 && (
            <div className="session-skeleton"><i /><i /></div>
          )}
          {!lists.loading && !query && sessions.length === 0 && projects.length === 0 && (
            <p className="sidebar-empty">No sessions yet.</p>
          )}
          {projects.map(project => (
            <div key={project.id} className={`session-item project-item${project.id === selectedProject ? ' active' : ''}${project.archived ? ' archived' : ''}`}>
              <button
                type="button"
                className="session-button"
                onClick={() => onSelectProject(project.id)}
                aria-current={project.id === selectedProject ? 'page' : undefined}
                title={project.goal ? `${project.name} — ${project.goal}` : project.name}
              >
                <span className="session-title">
                  <FolderKanban size={12} className="session-glyph project-glyph" />
                  <span>{project.name}</span>
                </span>
                <span className="session-time">{relativeTime(project.updatedAt)}</span>
              </button>
            </div>
          ))}
          {sessions.slice(0, limit).map(session => (
            <div key={session.id} className={`session-item${session.id === selectedSession ? ' active' : ''}`}>
              <button
                type="button"
                className="session-button"
                onClick={() => onSelectSession(session.id)}
                aria-current={session.id === selectedSession ? 'page' : undefined}
                title={session.title || 'Untitled session'}
              >
                <span className="session-title">
                  {session.parentSessionId
                    ? <GitBranch size={12} className="session-glyph" />
                    : session.agentType === 'work'
                      ? <Briefcase size={12} className="session-glyph" />
                      : <Code2 size={12} className="session-glyph" />}
                  <span>{session.title || 'Untitled session'}</span>
                </span>
                <span className="session-time">{relativeTime(session.updatedAt)}</span>
              </button>
              <Menu
                label="Session options"
                align="end"
                className="icon-button tiny session-more"
                trigger={<MoreHorizontal size={12} />}
                items={[
                  { key: 'fork', label: 'Fork', icon: <GitBranch size={14} />, onSelect: () => onFork(session.id) },
                  { key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => onDelete(session) },
                ]}
              />
            </div>
          ))}
          {hidden > 0 && (
            <button type="button" className="workspace-more" onClick={() => setShowAll(true)}>{hidden} more</button>
          )}
          {showAll && !query && (sessions.length > VISIBLE_SESSIONS || archived.length > 0) && (
            <button type="button" className="workspace-more" onClick={() => setShowAll(false)}>Show less</button>
          )}
        </div>
      )}
    </section>
  )
}

function ThemeSwitch({ value, onChange }: { value: ThemePreference; onChange: (value: ThemePreference) => void }) {
  const options: Array<{ value: ThemePreference; icon: typeof Sun; label: string }> = [
    { value: 'light', icon: Sun, label: 'Light' },
    { value: 'dark', icon: Moon, label: 'Dark' },
    { value: 'system', icon: Monitor, label: 'System' },
  ]
  return (
    <div className="segmented" role="radiogroup" aria-label="Theme">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.label}
          title={option.label}
          className={value === option.value ? 'active' : undefined}
          onClick={() => onChange(option.value)}
        >
          <option.icon size={12} />
        </button>
      ))}
    </div>
  )
}
