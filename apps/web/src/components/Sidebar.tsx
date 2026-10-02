import {
  Briefcase,
  Check,
  ChevronsUpDown,
  Code2,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  GitBranch,
  MessagesSquare,
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
import { useMemo, useRef, useState } from 'react'
import { folderName, relativeTime, useDismiss, type ThemePreference } from '../lib/hooks'
import type { ProjectRecord } from '../lib/project-types'
import type { SessionSummary } from '../lib/types'
import { AgentAvatar } from './AgentAvatar'
import { Menu } from './Menu'
import { UpdateButton } from './UpdateButton'
import type { DesktopUpdates } from '../lib/desktop-updates'

const DAY = 86_400_000

function groupSessions(sessions: readonly SessionSummary[], now = Date.now()) {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  const groups: Array<{ label: string; items: SessionSummary[] }> = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Previous 30 days', items: [] },
    { label: 'Older', items: [] },
  ]
  for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const t = session.updatedAt
    const index = t >= startOfToday ? 0 : t >= startOfToday - DAY ? 1 : t >= startOfToday - 7 * DAY ? 2 : t >= startOfToday - 30 * DAY ? 3 : 4
    groups[index]!.items.push(session)
  }
  return groups.filter(group => group.items.length)
}

export function Sidebar({
  workspaces,
  workspace,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  sessions,
  sessionsLoading,
  selectedId,
  onSelectSession,
  onNewSession,
  onForkSession,
  onDeleteSession,
  onOpenSettings,
  theme,
  onThemeChange,
  onCollapse,
  updates,
  mode,
  onModeChange,
  projects,
  projectsLoading,
  selectedProjectId,
  onSelectProject,
  onNewProject,
}: {
  mode: 'sessions' | 'projects'
  onModeChange: (mode: 'sessions' | 'projects') => void
  projects: ProjectRecord[]
  projectsLoading: boolean
  selectedProjectId: string | undefined
  onSelectProject: (id: string) => void
  onNewProject: () => void
  workspaces: string[]
  workspace: string | undefined
  onSelectWorkspace: (path: string) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (path: string) => void
  sessions: SessionSummary[]
  sessionsLoading: boolean
  selectedId: string | undefined
  onSelectSession: (id: string) => void
  onNewSession: () => void
  onForkSession: (id: string) => void
  onDeleteSession: (session: SessionSummary) => void
  onOpenSettings: () => void
  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void
  onCollapse: () => void
  /** Desktop self-update; absent in the browser. */
  updates?: DesktopUpdates | undefined
}) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? sessions.filter(session => (session.title || 'untitled').toLowerCase().includes(q)) : sessions
  }, [sessions, query])
  const groups = useMemo(() => groupSessions(filtered), [filtered])

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">tnega</span>
        </div>
        <button type="button" className="icon-button" onClick={onCollapse} aria-label="Hide sidebar" title="Hide sidebar (Ctrl+B)">
          <PanelLeftClose size={17} />
        </button>
      </div>

      <WorkspaceSwitcher
        workspaces={workspaces}
        workspace={workspace}
        onSelect={onSelectWorkspace}
        onAdd={onAddWorkspace}
        onRemove={onRemoveWorkspace}
      />

      <div className="segmented wide sidebar-modes" role="tablist" aria-label="Mode">
        <button type="button" role="tab" aria-selected={mode === 'sessions'} className={mode === 'sessions' ? 'active' : undefined} onClick={() => onModeChange('sessions')}>
          <MessagesSquare size={14} /> Sessions
        </button>
        <button type="button" role="tab" aria-selected={mode === 'projects'} className={mode === 'projects' ? 'active' : undefined} onClick={() => onModeChange('projects')}>
          <FolderKanban size={14} /> Projects
        </button>
      </div>

      {mode === 'projects'
        ? (
          <ProjectList
            projects={projects}
            loading={projectsLoading}
            selectedId={selectedProjectId}
            onSelect={onSelectProject}
            onNew={onNewProject}
            disabled={!workspace}
          />
        )
        : (
          <>
      <button type="button" className="new-session" onClick={onNewSession} disabled={!workspace}>
        <SquarePen size={16} />
        <span>New session</span>
        <kbd className="kbd-hint">Ctrl ⇧ O</kbd>
      </button>

      {sessions.length > 4 && (
        <label className="sidebar-search">
          <Search size={14} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search sessions" aria-label="Search sessions" />
          {query && (
            <button type="button" className="icon-button tiny" aria-label="Clear search" onClick={() => setQuery('')}><X size={13} /></button>
          )}
        </label>
      )}

      <nav className="session-list">
        {sessionsLoading && sessions.length === 0 && (
          <div className="session-skeleton">
            <i /><i /><i />
          </div>
        )}
        {!sessionsLoading && workspace && sessions.length === 0 && (
          <p className="sidebar-empty">No sessions yet. Start one and it will show up here.</p>
        )}
        {query && filtered.length === 0 && <p className="sidebar-empty">No sessions match “{query}”.</p>}
        {groups.map(group => (
          <section key={group.label} className="session-group">
            <h3 className="session-group-label">{group.label}</h3>
            {group.items.map(session => (
              <div key={session.id} className={`session-item${session.id === selectedId ? ' active' : ''}`}>
                <button
                  type="button"
                  className="session-button"
                  onClick={() => onSelectSession(session.id)}
                  aria-current={session.id === selectedId ? 'page' : undefined}
                  title={session.title || 'Untitled session'}
                >
                  <span className="session-title">
                    {session.parentSessionId && <GitBranch size={12} className="session-glyph" />}
                    {session.agentType === 'coding' && !session.parentSessionId && <Code2 size={12} className="session-glyph" />}
                    {session.agentType === 'work' && !session.parentSessionId && <Briefcase size={12} className="session-glyph" />}
                    <span>{session.title || 'Untitled session'}</span>
                  </span>
                  <span className="session-time">{relativeTime(session.updatedAt)}</span>
                </button>
                <Menu
                  label="Session options"
                  align="end"
                  className="icon-button tiny session-more"
                  trigger={<MoreHorizontal size={15} />}
                  items={[
                    { key: 'fork', label: 'Fork', icon: <GitBranch size={14} />, onSelect: () => onForkSession(session.id) },
                    { key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => onDeleteSession(session) },
                  ]}
                />
              </div>
            ))}
          </section>
        ))}
      </nav>
          </>
        )}

      <div className="sidebar-footer">
        <button type="button" className="sidebar-footer-button" onClick={onOpenSettings}>
          <Settings size={16} />
          <span>Settings</span>
        </button>
        <UpdateButton updates={updates} />
        <ThemeSwitch value={theme} onChange={onThemeChange} />
      </div>
    </aside>
  )
}

function ProjectList({
  projects,
  loading,
  selectedId,
  onSelect,
  onNew,
  disabled,
}: {
  projects: ProjectRecord[]
  loading: boolean
  selectedId: string | undefined
  onSelect: (id: string) => void
  onNew: () => void
  disabled: boolean
}) {
  const [showArchived, setShowArchived] = useState(false)
  const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt)
  const active = sorted.filter(project => !project.archived)
  const archived = sorted.filter(project => project.archived)
  const row = (project: ProjectRecord) => (
    <div key={project.id} className={`session-item${project.id === selectedId ? ' active' : ''}`}>
      <button
        type="button"
        className="session-button project-button"
        onClick={() => onSelect(project.id)}
        aria-current={project.id === selectedId ? 'page' : undefined}
        title={project.goal ? `${project.name} — ${project.goal}` : project.name}
      >
        <AgentAvatar id={project.coordinatorId} role="coordinator" size={30} />
        <span className="project-text">
          <span className="session-title"><span>{project.name}</span></span>
          {project.goal && <span className="project-goal">{project.goal}</span>}
        </span>
      </button>
    </div>
  )
  return (
    <>
      <button type="button" className="new-session" onClick={onNew} disabled={disabled}>
        <FolderPlus size={16} />
        <span>New project</span>
      </button>
      <nav className="session-list">
        {loading && projects.length === 0 && <div className="session-skeleton"><i /><i /></div>}
        {!loading && !disabled && projects.length === 0 && (
          <p className="sidebar-empty">Projects are long-running conversations where a coordinator runs parallel threads with shared memory.</p>
        )}
        {active.length > 0 && (
          <section className="session-group">
            <h3 className="session-group-label">Projects</h3>
            {active.map(row)}
          </section>
        )}
        {archived.length > 0 && (
          <section className="session-group">
            <button type="button" className="session-group-label as-button" onClick={() => setShowArchived(v => !v)} aria-expanded={showArchived}>
              Archived ({archived.length})
            </button>
            {showArchived && archived.map(row)}
          </section>
        )}
      </nav>
    </>
  )
}

function WorkspaceSwitcher({
  workspaces,
  workspace,
  onSelect,
  onAdd,
  onRemove,
}: {
  workspaces: string[]
  workspace: string | undefined
  onSelect: (path: string) => void
  onAdd: () => void
  onRemove: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useDismiss(open, root, () => setOpen(false))
  return (
    <div className="menu-root workspace-switcher" ref={root}>
      <button type="button" className="workspace-button" onClick={() => setOpen(v => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="workspace-icon"><FolderOpen size={15} /></span>
        <span className="workspace-text">
          <span className="workspace-name">{workspace ? folderName(workspace) : 'No workspace'}</span>
          <span className="workspace-path">{workspace ?? 'Open a folder to begin'}</span>
        </span>
        <ChevronsUpDown size={14} className="workspace-caret" />
      </button>
      {open && (
        <div className="menu-popover align-start side-bottom workspace-popover" role="listbox" aria-label="Workspaces">
          <div className="menu-heading">Workspaces</div>
          {workspaces.map(path => (
            <div key={path} className="workspace-option">
              <button
                type="button"
                role="option"
                aria-selected={path === workspace}
                className="menu-item menu-option"
                onClick={() => {
                  setOpen(false)
                  onSelect(path)
                }}
              >
                <span className="menu-item-icon"><FolderOpen size={14} /></span>
                <span className="menu-option-text">
                  <span className="menu-item-label">{folderName(path)}</span>
                  <span className="menu-option-desc mono">{path}</span>
                </span>
                <span className="menu-check">{path === workspace && <Check size={14} />}</span>
              </button>
              <button type="button" className="icon-button tiny workspace-remove" aria-label={`Remove ${folderName(path)} from list`} title="Remove from list" onClick={() => onRemove(path)}>
                <X size={13} />
              </button>
            </div>
          ))}
          {workspaces.length > 0 && <div className="menu-separator" />}
          <button type="button" className="menu-item" onClick={() => { setOpen(false); onAdd() }}>
            <span className="menu-item-icon"><FolderPlus size={14} /></span>
            <span className="menu-item-label">Open folder…</span>
          </button>
        </div>
      )}
    </div>
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
          <option.icon size={14} />
        </button>
      ))}
    </div>
  )
}
