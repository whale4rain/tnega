import { BookOpen, Bot, CalendarClock, FileText, FolderTree, GitCompareArrows, Globe, KanbanSquare, MessagesSquare, Settings2, SquareTerminal, X, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { fileName } from '../../lib/office'
import { BOARD_KEY, closeDoc, isProjectKey, isTool, openDoc, openTool, projectTabKey, select, type DocTab, type ProjectTabId, type ToolId, type WorkbenchState } from '../../lib/workbench'
import { PreviewView } from '../preview/FilePreview'
import { BrowserView } from './BrowserView'
import { ChangesView } from './ChangesView'
import { FilesView } from './FilesView'
import { SubagentView } from './SubagentView'
import { TerminalView } from './TerminalView'

const PROJECT_META: Record<ProjectTabId, { label: string; icon: LucideIcon; hint: string }> = {
  board: { label: 'Board', icon: KanbanSquare, hint: 'Every thread at a glance' },
  library: { label: 'Library', icon: BookOpen, hint: 'Files you added and outputs threads made' },
  routines: { label: 'Routines', icon: CalendarClock, hint: 'Recurring work on a schedule' },
}

/** What a project contributes to the panel: its tabs, and where it renders them. */
export interface WorkbenchProject {
  tabs: Array<{ tab: ProjectTabId; badge?: number; attention?: boolean }>
  /** The element the project view portals its active tab into. */
  slot: (element: HTMLDivElement | null) => void
}

/** Narrowest and widest the panel may be dragged, in CSS pixels. */
export const WORKBENCH_MIN_WIDTH = 360
export const WORKBENCH_MAX_SHARE = 0.72

const TOOL_META: Record<ToolId, { label: string; icon: LucideIcon; hint: string }> = {
  files: { label: 'Files', icon: FolderTree, hint: 'Browse and edit workspace files' },
  changes: { label: 'Changes', icon: GitCompareArrows, hint: 'What changed since the last commit' },
  terminal: { label: 'Terminal', icon: SquareTerminal, hint: 'Your shell in this workspace (Ctrl+`)' },
  browser: { label: 'Browser', icon: Globe, hint: 'The agent’s browser' },
}

/**
 * The Workbench: one panel for what you and the agent work on. A tab rail on
 * top (tools, then documents opened from the conversation), and below it each
 * view in the same shape — a toolbar row, then the content in a rounded card.
 *
 * Files, Changes and Terminal stay mounted once visited, so unsaved edits,
 * selections and shells survive switching tabs. The browser unmounts when
 * hidden, which also takes the desktop app's native page view off screen.
 */
export function Workbench({
  workspace,
  state,
  onChange,
  onClose,
  width,
  onResize,
  browser,
  changeCount,
  onChangeCount,
  project,
}: {
  workspace: string
  state: WorkbenchState
  onChange: (update: (state: WorkbenchState) => WorkbenchState) => void
  onClose: () => void
  width: number | undefined
  onResize: (width: number) => void
  browser: boolean
  changeCount: number | undefined
  onChangeCount: (count: number) => void
  /** Present on a project screen: its tabs lead the rail. */
  project?: WorkbenchProject | undefined
}) {
  const [visited, setVisited] = useState<ReadonlySet<ToolId>>(() => new Set(isTool(state.active) ? [state.active] : []))
  // Outside a project its tabs do not exist; show the first tool instead.
  const active = !project && isProjectKey(state.active) ? 'files' : state.active
  const projectDocs = project ? state.docs.filter(doc => doc.kind === 'thread' || doc.kind === 'exchange' || doc.kind === 'settings') : []
  const otherDocs = state.docs.filter(doc => doc.kind === 'preview' || doc.kind === 'subagent')
  if (isTool(active) && !visited.has(active)) setVisited(new Set([...visited, active]))
  const tools = (['files', 'changes', 'terminal', 'browser'] as const).filter(tool => tool !== 'browser' || browser)
  const keep = (tool: ToolId, view: ReactNode) => (visited.has(tool) || active === tool) && (
    <div className="wb-pane" hidden={active !== tool} key={tool}>{view}</div>
  )
  const doc = state.docs.find(item => item.key === active)

  return (
    <aside className="workbench" aria-label="Workbench">
      <ResizeHandle onResize={onResize} />
      <div className="wb-rail" role="tablist" aria-label="Workbench">
        {project?.tabs.map(({ tab, badge, attention }) => {
          const meta = PROJECT_META[tab]
          const key = projectTabKey(tab)
          const Icon = meta.icon
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active === key}
              className={`wb-tab${active === key ? ' active' : ''}`}
              title={meta.hint}
              onClick={() => onChange(current => select(current, key))}
            >
              <Icon size={14} aria-hidden />
              <span className="wb-tab-label">{meta.label}</span>
              {badge !== undefined && badge > 0 && <span className={`wb-count${attention ? ' attention' : ''}`}>{badge}</span>}
            </button>
          )
        })}
        {projectDocs.map(item => <DocTabButton key={item.key} doc={item} active={active === item.key} onSelect={() => onChange(current => select(current, item.key))} onClose={() => onChange(current => closeDoc(current, item.key, BOARD_KEY))} />)}
        {project && <span className="wb-rail-divider" aria-hidden />}
        {tools.map(tool => {
          const meta = TOOL_META[tool]
          const Icon = meta.icon
          return (
            <button
              key={tool}
              type="button"
              role="tab"
              aria-selected={active === tool}
              className={`wb-tab${active === tool ? ' active' : ''}`}
              title={meta.hint}
              onClick={() => onChange(current => select(current, tool))}
            >
              <Icon size={14} aria-hidden />
              <span className="wb-tab-label">{meta.label}</span>
              {tool === 'changes' && changeCount !== undefined && changeCount > 0 && <span className="wb-count">{changeCount}</span>}
            </button>
          )
        })}
        {otherDocs.length > 0 && <span className="wb-rail-divider" aria-hidden />}
        {otherDocs.map(item => <DocTabButton key={item.key} doc={item} active={active === item.key} onSelect={() => onChange(current => select(current, item.key))} onClose={() => onChange(current => closeDoc(current, item.key))} />)}
        <span className="wb-rail-fill" />
        <button type="button" className="icon-button small" aria-label="Close workbench" title="Close (Ctrl+J)" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="wb-body">
        {project && <div className="wb-pane" ref={project.slot} hidden={!isProjectKey(active)} />}
        {keep('files', <FilesView workspace={workspace} focus={state.focus} onPreview={path => onChange(current => openDoc(current, { kind: 'preview', path }))} />)}
        {keep('changes', <ChangesView workspace={workspace} visible={active === 'changes'} focus={state.focus} onCount={onChangeCount} onOpenInFiles={path => onChange(current => openTool(current, 'files', path))} onPreview={path => onChange(current => openDoc(current, { kind: 'preview', path }))} />)}
        {keep('terminal', <TerminalView workspace={workspace} visible={active === 'terminal'} />)}
        {active === 'browser' && browser && <div className="wb-pane"><BrowserView width={width} /></div>}
        {doc?.kind === 'preview' && <div className="wb-pane" key={doc.key}><PreviewView workspace={workspace} path={doc.path} /></div>}
        {doc?.kind === 'subagent' && (
          <div className="wb-pane" key={doc.key}>
            <SubagentView workspace={workspace} id={doc.id} label={doc.label} onOpenSubagent={(id, label) => onChange(current => openDoc(current, { kind: 'subagent', id, label }))} />
          </div>
        )}
      </div>
    </aside>
  )
}

const DOC_ICON: Record<DocTab['kind'], LucideIcon> = {
  preview: FileText,
  subagent: Bot,
  thread: MessagesSquare,
  exchange: MessagesSquare,
  settings: Settings2,
}

function DocTabButton({ doc, active, onSelect, onClose }: { doc: DocTab; active: boolean; onSelect: () => void; onClose: () => void }) {
  const label = doc.kind === 'preview' ? fileName(doc.path) : doc.label
  const Icon = DOC_ICON[doc.kind]
  const title = doc.kind === 'preview' ? doc.path : doc.kind === 'subagent' ? `Subagent ${doc.label}` : doc.kind === 'thread' ? `Thread ${doc.label}` : doc.label
  return (
    <div className={`wb-tab doc${active ? ' active' : ''}`} role="tab" aria-selected={active} title={title}>
      <button type="button" className="wb-tab-main" onClick={onSelect}>
        <Icon size={14} aria-hidden />
        <span className="wb-tab-label">{label}</span>
      </button>
      <button type="button" className="wb-tab-close" aria-label={`Close ${label}`} onClick={onClose}>
        <X size={11} />
      </button>
    </div>
  )
}

function ResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  const [dragging, setDragging] = useState(false)
  return (
    <div
      className={`wb-resize${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize workbench"
      onPointerDown={event => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={event => {
        if (!dragging) return
        const max = window.innerWidth * WORKBENCH_MAX_SHARE
        onResize(Math.round(Math.min(max, Math.max(WORKBENCH_MIN_WIDTH, window.innerWidth - event.clientX))))
      }}
      onPointerUp={event => {
        event.currentTarget.releasePointerCapture(event.pointerId)
        setDragging(false)
      }}
    />
  )
}
