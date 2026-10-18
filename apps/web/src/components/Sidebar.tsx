import {
  Archive,
  ArchiveRestore,
  ChevronRight,
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
import { useEffect, useMemo, useRef, useState } from 'react'
import { PullRequestMark } from './PullRequestMark'
import { api } from '../lib/api'
import { folderName, relativeTime, useScrollFade, type ThemePreference } from '../lib/hooks'
import { projectApi } from '../lib/project-api'
import { projectLight, type LightTone } from '../lib/project-model'
import { StatusLight } from './StatusLight'
import type { ProjectRecord } from '../lib/project-types'
import type { SessionSummary } from '../lib/types'
import { Menu } from './Menu'
import { UpdateButton } from './UpdateButton'
import type { DesktopUpdates } from '../lib/desktop-updates'

/** Sessions shown per workspace, and projects under Pinned, before "N more". */
const VISIBLE_SESSIONS = 8
const VISIBLE_PROJECTS = 8
const COLLAPSED_KEY = 'tnega.sidebar.collapsed'
/** Pinned's entry in the collapsed set; no workspace path starts with a NUL. */
const PINNED_KEY = '\0pinned'

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
 * The sidebar has two parts: Pinned, every project from every workspace, and
 * below it one collapsible group of sessions per workspace, the most recently
 * active workspace first. Both collapse and show a few rows before "N more".
 * A session row is a status light and a title; a project row is a project icon, its
 * name, and at the end its status light and pull request mark when it has
 * them. Times and workspaces are in the tooltip.
 *
 * The current workspace's lists come from the app (they stay live) once they
 * have loaded for it; the others, and the current one until then, come from
 * the sidebar's own copy, so moving to another workspace never blanks a list.
 */
export function Sidebar({
  workspaces,
  defaultWorkspace,
  workspace,
  onAddWorkspace,
  onRemoveWorkspace,
  sessions,
  sessionsLoading,
  projects,
  projectsLoading,
  listsReady = true,
  mode,
  selectedId,
  selectedProjectId,
  onSelectSession,
  onSelectProject,
  onNewSession,
  onNewProject,
  onForkSession,
  onDeleteSession,
  onArchiveProject,
  onDeleteProject,
  onOpenSettings,
  theme,
  onThemeChange,
  onCollapse,
  updates,
}: {
  workspaces: string[]
  /** Where a new session starts when no folder is chosen; listed with the others. */
  defaultWorkspace?: string | undefined
  workspace: string | undefined
  onAddWorkspace: () => void
  onRemoveWorkspace: (path: string) => void
  sessions: SessionSummary[]
  sessionsLoading: boolean
  projects: ProjectRecord[]
  projectsLoading: boolean
  /** The live lists belong to `workspace`; false right after a switch, until they load. Defaults to true. */
  listsReady?: boolean
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
  /** Resolves true when the project changed. */
  onArchiveProject: (workspace: string, project: ProjectRecord) => Promise<boolean>
  /** Asks first; resolves true when the project was deleted. */
  onDeleteProject: (workspace: string, project: ProjectRecord) => Promise<boolean>
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

  // Keep a copy of the live lists: when the app moves to another workspace they become that workspace's copy,
  // shown until the next refresh instead of a blank list.
  const live = listsReady && workspace && !sessionsLoading && !projectsLoading ? { path: workspace, sessions, projects } : undefined
  const [kept, setKept] = useState(live)
  if (live && (kept?.path !== live.path || kept.sessions !== live.sessions || kept.projects !== live.projects)) setKept(live)
  const [shown, setShown] = useState(workspace)
  if (shown !== workspace) {
    setShown(workspace)
    if (kept && kept.path === shown) {
      setOthers(current => ({ ...current, [kept.path]: { sessions: kept.sessions, projects: kept.projects, loading: false } }))
    }
  }

  // Load each other workspace once, collapsed or not, so Pinned lists all projects; reopening the sidebar refreshes them.
  const pending = workspaces.filter(path => path !== workspace && !others[path])
  useEffect(() => {
    for (const path of pending) load(path)
  }, [pending.join('\n')])

  const listsFor = (path: string): WorkspaceLists => path === workspace && live
    ? { sessions, projects, loading: false }
    : others[path] ?? { sessions: [], projects: [], loading: path === workspace }

  const q = query.trim().toLowerCase()

  // Every project, from every workspace, is pinned above the sessions; archived ones wait behind "more".
  const [showArchived, setShowArchived] = useState(false)
  const pinned = workspaces
    .flatMap(path => listsFor(path).projects.map(project => ({ path, project })))
    .filter(({ project }) => !q || project.name.toLowerCase().includes(q))
    .sort((a, b) => b.project.updatedAt - a.project.updatedAt)
  const selectedPinned = (path: string, id: string) => path === workspace && mode === 'projects' && id === selectedProjectId
  const archived = pinned.filter(({ path, project }) => project.archived && !selectedPinned(path, project.id))
  const current = pinned.filter(item => !archived.includes(item))
  const shownPinned = showArchived || q ? [...current, ...archived] : current
  const pinnedOpen = !collapsed.has(PINNED_KEY) || Boolean(q)
  // A few projects, then "N more"; the open project and any that waits on you or failed stay in view.
  const [allPinned, setAllPinned] = useState(false)
  const needsLook = ({ path, project }: { path: string; project: ProjectRecord }) => selectedPinned(path, project.id)
    || Boolean(project.threads && (project.threads.waiting > 0 || project.threads.failed > 0))
  const visiblePinned = allPinned || q ? shownPinned : shownPinned.filter((item, index) => index < VISIBLE_PROJECTS || needsLook(item))
  const hiddenPinned = shownPinned.length - visiblePinned.length
  const reload = (path: string) => { if (path !== workspace) load(path) }

  // Workspaces are ordered by their latest session, newest first; the list order breaks ties.
  const latest = (path: string) => Math.max(0, ...listsFor(path).sessions.map(session => session.updatedAt))
  const ordered = workspaces
    .map((path, index) => ({ path, index, at: latest(path) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(item => item.path)

  // The list ends on a hard line under the footer: fade it out instead. The top
  // edge keeps its hard cut because the group labels stick to it while scrolling.
  const sessionList = useRef<HTMLElement>(null)
  useScrollFade(sessionList, 'bottom')

  return (
    <aside className="sidebar" aria-label="Workspaces">
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">tnega</span>
        </div>
        <span className="sidebar-top-actions">
          <button type="button" className="icon-button" onClick={() => { const target = defaultWorkspace ?? workspace; if (target) onNewSession(target) }} disabled={!defaultWorkspace && !workspace} aria-label="New session" title="New session (Ctrl+Shift+O)">
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

      <nav className="session-list workspace-tree scroll-fade" ref={sessionList}>
        {shownPinned.length > 0 && (
          <section className={`sidebar-section${pinnedOpen ? ' open' : ''}`} aria-label="Pinned">
            <div className="workspace-head">
              <button type="button" className="workspace-toggle" onClick={() => toggle(PINNED_KEY)} aria-expanded={pinnedOpen}>
                <ChevronRight size={12} className="workspace-chevron" aria-hidden />
                <span className="workspace-name">Pinned</span>
              </button>
            </div>
            {pinnedOpen && visiblePinned.map(({ path, project }) => (
              <ProjectRow
                key={`${path}\0${project.id}`}
                project={project}
                path={path}
                active={selectedPinned(path, project.id)}
                onSelect={() => onSelectProject(path, project.id)}
                onArchive={() => void onArchiveProject(path, project).then(changed => { if (changed) reload(path) })}
                onDelete={() => void onDeleteProject(path, project).then(deleted => { if (deleted) reload(path) })}
              />
            ))}
            {pinnedOpen && hiddenPinned > 0 && (
              <button type="button" className="workspace-more" onClick={() => setAllPinned(true)}>{hiddenPinned} more</button>
            )}
            {pinnedOpen && allPinned && !q && shownPinned.length > VISIBLE_PROJECTS && (
              <button type="button" className="workspace-more" onClick={() => setAllPinned(false)}>Show less</button>
            )}
            {pinnedOpen && archived.length > 0 && !q && (
              <button type="button" className="workspace-more" onClick={() => setShowArchived(show => !show)}>
                {showArchived ? 'Hide archived' : `${archived.length} archived`}
              </button>
            )}
          </section>
        )}
        {workspaces.length === 0 && <p className="sidebar-empty">Open a folder to start working in it.</p>}
        {ordered.map(path => (
          <WorkspaceGroup
            key={path}
            path={path}
            label={path === defaultWorkspace ? 'No folder' : undefined}
            removable={path !== defaultWorkspace}
            current={path === workspace}
            open={!collapsed.has(path) || Boolean(q)}
            lists={listsFor(path)}
            query={q}
            selectedSession={path === workspace && mode === 'sessions' ? selectedId : undefined}
            onToggle={() => toggle(path)}
            onSelectSession={id => onSelectSession(path, id)}
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
  label,
  removable,
  current,
  open,
  lists,
  query,
  selectedSession,
  onToggle,
  onSelectSession,
  onNewSession,
  onNewProject,
  onFork,
  onDelete,
  onRemove,
}: {
  path: string
  /** Shown instead of the folder name. */
  label: string | undefined
  removable: boolean
  current: boolean
  open: boolean
  lists: WorkspaceLists
  query: string
  selectedSession: string | undefined
  onToggle: () => void
  onSelectSession: (id: string) => void
  onNewSession: () => void
  onNewProject: () => void
  onFork: (id: string) => void
  onDelete: (session: SessionSummary) => void
  onRemove: () => void
}) {
  const [showAll, setShowAll] = useState(false)
  const name = label ?? folderName(path)
  const sessions = useMemo(() => lists.sessions
    .filter(session => !query || (session.title || 'untitled').toLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt), [lists.sessions, query])
  // Keep the open session visible even when it is older than the first few.
  const selectedIndex = selectedSession ? sessions.findIndex(session => session.id === selectedSession) : -1
  const limit = showAll || query ? sessions.length : Math.max(VISIBLE_SESSIONS, selectedIndex + 1)
  const hidden = Math.max(0, sessions.length - limit)
  if (query && sessions.length === 0) return null

  return (
    <section className={`workspace-group${open ? ' open' : ''}${current ? ' current' : ''}`}>
      <div className="workspace-head">
        <button type="button" className="workspace-toggle" onClick={onToggle} aria-expanded={open} title={path}>
          <ChevronRight size={12} className="workspace-chevron" aria-hidden />
          <span className="workspace-name">{name}</span>
        </button>
        <span className="workspace-actions">
          <button type="button" className="icon-button tiny" onClick={onNewProject} aria-label={`New project in ${name}`} title="New project">
            <FolderKanban size={12} />
          </button>
          <button type="button" className="icon-button tiny" onClick={onNewSession} aria-label={`New session in ${name}`} title="New session">
            <SquarePen size={12} />
          </button>
          {removable && (
            <Menu
              label={`${name} options`}
              align="end"
              className="icon-button tiny"
              trigger={<MoreHorizontal size={12} />}
              items={[{ key: 'remove', label: 'Remove from list', icon: <X size={14} />, onSelect: onRemove }]}
            />
          )}
        </span>
      </div>

      {open && (
        <div className="workspace-items">
          {lists.loading && sessions.length === 0 && (
            <div className="session-skeleton"><i /><i /></div>
          )}
          {!lists.loading && !query && sessions.length === 0 && (
            <p className="sidebar-empty">No sessions yet.</p>
          )}
          {sessions.slice(0, limit).map(session => (
            <div key={session.id} className={`session-item${session.id === selectedSession ? ' active' : ''}`}>
              <button
                type="button"
                className="session-button"
                onClick={() => onSelectSession(session.id)}
                aria-current={session.id === selectedSession ? 'page' : undefined}
                title={`${session.title || 'Untitled session'}\n${session.parentSessionId ? 'Forked · ' : ''}${relativeTime(session.updatedAt)}`}
              >
                <span className="session-title">
                  <span className="session-mark"><StatusLight {...sessionLight(session)} /></span>
                  <span>{session.title || 'Untitled session'}</span>
                </span>
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
          {showAll && !query && sessions.length > VISIBLE_SESSIONS && (
            <button type="button" className="workspace-more" onClick={() => setShowAll(false)}>Show less</button>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * A project: its icon, its name, then what needs a look (the status light) and
 * where its pull requests stand. The menu archives or deletes it.
 */
function ProjectRow({
  project,
  path,
  active,
  onSelect,
  onArchive,
  onDelete,
}: {
  project: ProjectRecord
  path: string
  active: boolean
  onSelect: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const light = projectLight(project.threads)
  return (
    <div className={`session-item project-item${active ? ' active' : ''}${project.archived ? ' archived' : ''}`}>
      <button
        type="button"
        className="session-button"
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        title={[project.name, project.goal, `${folderName(path)} · ${relativeTime(project.updatedAt)}`].filter(Boolean).join('\n')}
      >
        <span className="session-title">
          <span className="session-mark"><FolderKanban size={14} className="project-icon" aria-hidden /></span>
          <span>{project.name}</span>
        </span>
        {(light || Boolean(project.pullRequests?.length)) && (
          <span className="project-marks">
            {light && <StatusLight tone={light.tone} label={light.label} />}
            <PullRequestMark pullRequests={project.pullRequests} />
          </span>
        )}
      </button>
      <Menu
        label={`${project.name} options`}
        align="end"
        className="icon-button tiny session-more"
        trigger={<MoreHorizontal size={12} />}
        items={[
          project.archived
            ? { key: 'restore', label: 'Restore', icon: <ArchiveRestore size={14} />, onSelect: onArchive }
            : { key: 'archive', label: 'Archive', icon: <Archive size={14} />, onSelect: onArchive },
          { key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: onDelete },
        ]}
      />
    </div>
  )
}

/**
 * A session's light says what needs you: amber while its approval card waits,
 * pulsing accent while a run goes, and plain otherwise. Only this browser
 * knows about a run it started, so the server reports both states.
 */
function sessionLight(session: SessionSummary): { tone: LightTone; label: string } {
  if (session.waiting) return { tone: 'waiting', label: 'Waiting on you' }
  if (session.running) return { tone: 'working', label: 'Working' }
  return { tone: 'idle', label: 'Idle' }
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
