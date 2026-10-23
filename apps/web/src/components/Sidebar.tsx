import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Copy,
  FolderKanban,
  FolderPlus,
  GitBranch,
  Link,
  Monitor,
  Moon,
  ListChecks,
  MoreHorizontal,
  PanelLeftClose,
  Search,
  Settings,
  SquarePen,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { PullRequestMark } from './PullRequestMark'
import { api } from '../lib/api'
import { sessionLink } from '@tnega/client/session-link'
import { copyToClipboard, folderName, relativeTime, useScrollFade, type ThemePreference } from '../lib/hooks'
import { projectApi } from '../lib/project-api'
import { projectLight, type LightTone } from '../lib/project-model'
import { StatusLight } from './StatusLight'
import type { ProjectRecord } from '../lib/project-types'
import type { SessionSearchHit, SessionSummary } from '../lib/types'
import { Menu } from './Menu'
import { UpdateButton } from './UpdateButton'
import type { DesktopUpdates } from '../lib/desktop-updates'

/** Sessions shown per workspace, and projects under Pinned, before "N more". */
const VISIBLE_SESSIONS = 8
const VISIBLE_PROJECTS = 8
const COLLAPSED_KEY = 'tnega.sidebar.collapsed'
/** Pinned's entry in the collapsed set; no workspace path starts with a NUL. */
const PINNED_KEY = '\0pinned'
/** Message search starts at this many characters; titles filter from the first. */
const SEARCH_MIN = 2
/** Coming back to the window refreshes the lists at most this often. */
const REFRESH_GAP_MS = 3_000

/** A session picked for a batch action, with the workspace it lives in. */
export interface PickedSession {
  path: string
  session: SessionSummary
}

const pickKey = (path: string, id: string) => `${path}\0${id}`

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
 * Opening the sidebar and coming back to the window refresh every list.
 *
 * Search filters titles at once and, from two characters, also finds sessions
 * by what was said in them; those rows show the matching line. "Select" turns
 * the session lights into checkboxes for deleting several sessions at once.
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
  onDeleteSessions,
  onRefresh,
  focusSearch = 0,
  onArchiveProject,
  onDeleteProject,
  onOpenSettings,
  theme,
  onThemeChange,
  onCollapse,
  updates,
  open = true,
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
  /** Asks first; resolves true when any of them was deleted. */
  onDeleteSessions?: (sessions: PickedSession[]) => Promise<boolean>
  /** Reloads the current workspace's live lists; called when the sidebar opens and when the window comes back. */
  onRefresh?: () => void
  /** Bumped to move the focus into the search box. */
  focusSearch?: number
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
  /**
   * False while folded away. The app keeps the sidebar mounted so folding it is a slide, not a
   * rebuild: its search, scroll and expanded groups survive, and reopening refreshes in place.
   */
  open?: boolean
}) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [others, setOthers] = useState<Record<string, WorkspaceLists>>({})
  const searchBox = useRef<HTMLInputElement>(null)

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

  // Opening the sidebar, and coming back to the window, refresh every list: the
  // current one through the app, the others here. Sessions started elsewhere
  // (the terminal, another window) show up without waiting for the poll.
  const lastRefresh = useRef(0)
  const refreshAll = useRef<() => void>(() => {})
  refreshAll.current = () => {
    lastRefresh.current = Date.now()
    onRefresh?.()
    for (const path of workspaces) if (path !== workspace && others[path] && !others[path].loading) load(path)
  }
  const isOpen = useRef(open)
  useEffect(() => {
    if (open && !isOpen.current) refreshAll.current()
    isOpen.current = open
  }, [open])
  useEffect(() => {
    if (open && listsReady && !sessionsLoading && !projectsLoading) onRefresh?.()
    lastRefresh.current = Date.now()
    const onBack = () => {
      if (!isOpen.current || document.visibilityState !== 'visible' || Date.now() - lastRefresh.current < REFRESH_GAP_MS) return
      refreshAll.current()
    }
    window.addEventListener('focus', onBack)
    document.addEventListener('visibilitychange', onBack)
    return () => {
      window.removeEventListener('focus', onBack)
      document.removeEventListener('visibilitychange', onBack)
    }
  }, [])

  useEffect(() => {
    if (focusSearch) searchBox.current?.focus()
  }, [focusSearch])

  const listsFor = (path: string): WorkspaceLists => path === workspace && live
    ? { sessions, projects, loading: false }
    : others[path] ?? { sessions: [], projects: [], loading: path === workspace }

  const q = query.trim().toLowerCase()

  // What was said in each workspace's sessions, from the server; titles are matched here.
  const [hits, setHits] = useState<{ query: string; byPath: Record<string, Map<string, string>> }>()
  const workspaceKey = workspaces.join('\n')
  useEffect(() => {
    if (q.length < SEARCH_MIN) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void Promise.all(workspaces.map(path => api.searchSessions(path, q, controller.signal)
        .then(result => [path, result.hits] as const, () => [path, [] as SessionSearchHit[]] as const)))
        .then(entries => {
          if (controller.signal.aborted) return
          setHits({ query: q, byPath: Object.fromEntries(entries.map(([path, found]) => [path, new Map(found.map(hit => [hit.id, hit.snippet]))])) })
        })
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [q, workspaceKey])
  const searchingMessages = q.length >= SEARCH_MIN && hits?.query !== q
  const snippetsFor = (path: string) => q.length >= SEARCH_MIN && hits?.query === q ? hits.byPath[path] : undefined

  // Picking sessions for a batch delete. A pick remembers its workspace, so a batch can span several.
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Map<string, PickedSession>>(() => new Map())
  const [anchor, setAnchor] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  const stopSelecting = () => {
    setSelecting(false)
    setPicked(new Map())
    setAnchor(undefined)
  }
  const startSelecting = (first?: PickedSession) => {
    setSelecting(true)
    setPicked(first ? new Map([[pickKey(first.path, first.session.id), first]]) : new Map())
    setAnchor(first ? pickKey(first.path, first.session.id) : undefined)
  }
  /** Toggles one session; with `range` (the group's rows in order) it picks everything from the last pick to it. */
  const pick = (path: string, session: SessionSummary, range?: SessionSummary[]) => {
    const key = pickKey(path, session.id)
    setPicked(current => {
      const next = new Map(current)
      const from = range && anchor ? range.findIndex(item => pickKey(path, item.id) === anchor) : -1
      if (range && from >= 0) {
        const to = range.findIndex(item => item.id === session.id)
        for (const item of range.slice(Math.min(from, to), Math.max(from, to) + 1)) next.set(pickKey(path, item.id), { path, session: item })
      } else if (next.has(key)) next.delete(key)
      else next.set(key, { path, session })
      return next
    })
    setAnchor(key)
  }
  const pickAll = (path: string, sessions: SessionSummary[]) => setPicked(current => {
    const next = new Map(current)
    const all = sessions.every(session => next.has(pickKey(path, session.id)))
    for (const session of sessions) {
      if (all) next.delete(pickKey(path, session.id))
      else next.set(pickKey(path, session.id), { path, session })
    }
    return next
  })
  const deletePicked = () => {
    if (!onDeleteSessions || picked.size === 0 || deleting) return
    const batch = [...picked.values()]
    setDeleting(true)
    void onDeleteSessions(batch).then(deleted => {
      setDeleting(false)
      if (!deleted) return
      stopSelecting()
      for (const path of new Set(batch.map(item => item.path))) if (path !== workspace) load(path)
    }, () => setDeleting(false))
  }
  useEffect(() => {
    if (!selecting) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting && !event.defaultPrevented) stopSelecting()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting, deleting])

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

  // Whether the search found anything at all, to say so when it didn't.
  const anyMatch = shownPinned.length > 0 || workspaces.some(path => {
    const snippets = snippetsFor(path)
    return listsFor(path).sessions.some(session => matchesTitle(session, q) || Boolean(snippets?.has(session.id)))
  })

  // New sessions start in the default folder; a new project starts where you are, and its dialog can move it.
  const newSessionTarget = defaultWorkspace
  const newTarget = workspace ?? defaultWorkspace

  // The list ends on a hard line under the footer: fade it out instead. The top
  // edge keeps its hard cut because the group labels stick to it while scrolling.
  const sessionList = useRef<HTMLElement>(null)
  useScrollFade(sessionList, 'bottom')

  return (
    <aside className={`sidebar${open ? '' : ' is-closed'}`} aria-label="Workspaces" aria-hidden={!open || undefined} inert={!open}>
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">tnega</span>
        </div>
        <span className="sidebar-top-actions">
          <button type="button" className="icon-button" onClick={onCollapse} aria-label="Hide sidebar" title="Hide sidebar (Ctrl+B)">
            <PanelLeftClose size={14} />
          </button>
        </span>
      </div>

      <div className="sidebar-actions">
        <button type="button" className="sidebar-action" onClick={() => { if (newTarget) onNewSession(newSessionTarget ?? newTarget) }} disabled={!newTarget} title="New session (Ctrl+Shift+O)">
          <SquarePen size={14} aria-hidden />
          <span>New session</span>
        </button>
        <button type="button" className="sidebar-action" onClick={() => { if (newTarget) onNewProject(newTarget) }} disabled={!newTarget} title="New project: a coordinator splits one goal into parallel threads">
          <FolderKanban size={14} aria-hidden />
          <span>New project</span>
        </button>
      </div>

      <label className="sidebar-search">
        <Search size={12} />
        <input
          ref={searchBox}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); setQuery('') } }}
          placeholder="Search"
          aria-label="Search sessions and projects"
          title="Search titles and messages (Ctrl+K)"
        />
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
            snippets={snippetsFor(path)}
            selecting={selecting}
            isPicked={id => picked.has(pickKey(path, id))}
            onPick={(session, range) => pick(path, session, range)}
            onPickAll={sessions => pickAll(path, sessions)}
            onStartSelecting={onDeleteSessions ? session => startSelecting(session ? { path, session } : undefined) : undefined}
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
        {q && searchingMessages && <p className="sidebar-empty" role="status">Searching messages…</p>}
        {q && !searchingMessages && !anyMatch && <p className="sidebar-empty" role="status">Nothing matches “{query.trim()}”.</p>}
      </nav>

      {selecting && (
        <div className="sidebar-select-bar" role="toolbar" aria-label="Selected sessions">
          <span className="sidebar-select-count" aria-live="polite">{picked.size === 0 ? 'Select sessions' : `${picked.size} selected`}</span>
          <button type="button" className="button ghost small" onClick={stopSelecting}>Cancel</button>
          <button type="button" className="button danger small" onClick={deletePicked} disabled={picked.size === 0 || deleting}>
            <Trash2 size={12} aria-hidden /> Delete
          </button>
        </div>
      )}

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

const matchesTitle = (session: SessionSummary, query: string) => !query || (session.title || 'untitled').toLowerCase().includes(query)

/** Wraps each occurrence of `query` in a highlight; the text is shown as is otherwise. */
function highlight(text: string, query: string): ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(query); at >= 0; at = lower.indexOf(query, at + query.length)) {
    parts.push(text.slice(from, at), <mark key={at} className="search-mark">{text.slice(at, at + query.length)}</mark>)
    from = at + query.length
  }
  parts.push(text.slice(from))
  return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>)
}

function WorkspaceGroup({
  path,
  label,
  removable,
  current,
  open,
  lists,
  query,
  snippets,
  selectedSession,
  selecting,
  isPicked,
  onPick,
  onPickAll,
  onStartSelecting,
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
  /** Sessions whose messages match the search, with the matching line. */
  snippets: Map<string, string> | undefined
  selectedSession: string | undefined
  selecting: boolean
  isPicked: (id: string) => boolean
  onPick: (session: SessionSummary, range?: SessionSummary[]) => void
  onPickAll: (sessions: SessionSummary[]) => void
  /** Absent when sessions can't be deleted in a batch. */
  onStartSelecting: ((session?: SessionSummary) => void) | undefined
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
    .filter(session => matchesTitle(session, query) || Boolean(snippets?.has(session.id)))
    .sort((a, b) => b.updatedAt - a.updatedAt), [lists.sessions, query, snippets])
  // Keep the open session visible even when it is older than the first few.
  const selectedIndex = selectedSession ? sessions.findIndex(session => session.id === selectedSession) : -1
  const limit = showAll || query ? sessions.length : Math.max(VISIBLE_SESSIONS, selectedIndex + 1)
  const hidden = Math.max(0, sessions.length - limit)
  if (query && sessions.length === 0) return null
  const allPicked = sessions.length > 0 && sessions.every(session => isPicked(session.id))

  const clickRow = (event: MouseEvent, session: SessionSummary) => {
    if (selecting) onPick(session, event.shiftKey ? sessions.slice(0, limit) : undefined)
    // Ctrl or Cmd + click starts a selection with this row, as in a file list.
    else if ((event.ctrlKey || event.metaKey) && onStartSelecting) onStartSelecting(session)
    else onSelectSession(session.id)
  }

  return (
    <section className={`workspace-group${open ? ' open' : ''}${current ? ' current' : ''}`}>
      <div className="workspace-head">
        <button type="button" className="workspace-toggle" onClick={onToggle} aria-expanded={open} title={path}>
          <ChevronRight size={12} className="workspace-chevron" aria-hidden />
          <span className="workspace-name">{name}</span>
        </button>
        {selecting
          ? sessions.length > 0 && (
            <button type="button" className="workspace-pick-all" onClick={() => onPickAll(sessions)}>
              {allPicked ? 'Clear' : 'Select all'}
            </button>
          )
          : (
            <span className="workspace-actions">
              <button type="button" className="icon-button tiny" onClick={onNewProject} aria-label={`New project in ${name}`} title="New project">
                <FolderKanban size={12} />
              </button>
              <button type="button" className="icon-button tiny" onClick={onNewSession} aria-label={`New session in ${name}`} title="New session">
                <SquarePen size={12} />
              </button>
              {(removable || (onStartSelecting && lists.sessions.length > 0)) && (
                <Menu
                  label={`${name} options`}
                  align="end"
                  className="icon-button tiny"
                  trigger={<MoreHorizontal size={12} />}
                  items={[
                    ...(onStartSelecting && lists.sessions.length > 0
                      ? [{ key: 'select', label: 'Select sessions', icon: <ListChecks size={14} />, onSelect: () => onStartSelecting() }]
                      : []),
                    ...(removable ? [{ key: 'remove', label: 'Remove from list', icon: <X size={14} />, onSelect: onRemove }] : []),
                  ]}
                />
              )}
            </span>
          )}
      </div>

      {open && (
        <div className="workspace-items">
          {lists.loading && sessions.length === 0 && (
            <div className="session-skeleton"><i /><i /></div>
          )}
          {!lists.loading && !query && sessions.length === 0 && (
            <p className="sidebar-empty">No sessions yet.</p>
          )}
          {sessions.slice(0, limit).map(session => {
            const title = session.title || 'Untitled session'
            const picked = selecting && isPicked(session.id)
            // A row found by what was said in it shows that line; a title match needs nothing more.
            const snippet = query && !matchesTitle(session, query) ? snippets?.get(session.id) : undefined
            return (
              <div key={session.id} className={`session-item${session.id === selectedSession && !selecting ? ' active' : ''}${picked ? ' picked' : ''}${snippet ? ' has-snippet' : ''}`}>
                <button
                  type="button"
                  className="session-button"
                  onClick={event => clickRow(event, session)}
                  {...(selecting
                    ? { role: 'checkbox', 'aria-checked': picked }
                    : { 'aria-current': session.id === selectedSession ? 'page' as const : undefined })}
                  title={`${title}\n${session.parentSessionId ? 'Forked · ' : ''}${relativeTime(session.updatedAt)}`}
                >
                  <span className="session-title">
                    <span className="session-mark">
                      {selecting
                        ? <span className={`session-check${picked ? ' on' : ''}`} aria-hidden>{picked && <Check size={10} strokeWidth={2.5} />}</span>
                        : <StatusLight {...sessionLight(session)} />}
                    </span>
                    <span>{highlight(title, query)}</span>
                  </span>
                  {snippet && <span className="session-snippet">{highlight(snippet, query)}</span>}
                </button>
                {!selecting && (
                  <Menu
                    label="Session options"
                    align="end"
                    className="icon-button tiny session-more"
                    trigger={<MoreHorizontal size={12} />}
                    items={[
                      { key: 'fork', label: 'Fork', icon: <GitBranch size={14} />, onSelect: () => onFork(session.id) },
                      { key: 'copy-link', label: 'Copy link', icon: <Link size={14} />, onSelect: () => copyToClipboard(sessionLink(path, session.id)) },
                      { key: 'copy-id', label: 'Copy ID', icon: <Copy size={14} />, onSelect: () => copyToClipboard(session.id) },
                      ...(onStartSelecting ? [{ key: 'select', label: 'Select', icon: <ListChecks size={14} />, onSelect: () => onStartSelecting(session) }] : []),
                      { key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => onDelete(session) },
                    ]}
                  />
                )}
              </div>
            )
          })}
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
