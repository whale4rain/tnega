import { Bot, FileText, FolderTree, GitCompareArrows, Globe, SquareTerminal, X, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { fileName } from '../../lib/office'
import { closeDoc, isTool, openDoc, openTool, select, type DocTab, type ToolId, type WorkbenchState } from '../../lib/workbench'
import { PreviewView } from '../preview/FilePreview'
import { BrowserView } from './BrowserView'
import { ChangesView } from './ChangesView'
import { FilesView } from './FilesView'
import { SubagentView } from './SubagentView'
import { TerminalView } from './TerminalView'

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
}) {
  const [visited, setVisited] = useState<ReadonlySet<ToolId>>(() => new Set(isTool(state.active) ? [state.active] : []))
  const active = state.active
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
        {state.docs.length > 0 && <span className="wb-rail-divider" aria-hidden />}
        {state.docs.map(item => <DocTabButton key={item.key} doc={item} active={active === item.key} onSelect={() => onChange(current => select(current, item.key))} onClose={() => onChange(current => closeDoc(current, item.key))} />)}
        <span className="wb-rail-fill" />
        <button type="button" className="icon-button small" aria-label="Close workbench" title="Close (Ctrl+J)" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="wb-body">
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

function DocTabButton({ doc, active, onSelect, onClose }: { doc: DocTab; active: boolean; onSelect: () => void; onClose: () => void }) {
  const label = doc.kind === 'preview' ? fileName(doc.path) : doc.label
  const Icon = doc.kind === 'preview' ? FileText : Bot
  return (
    <div className={`wb-tab doc${active ? ' active' : ''}`} role="tab" aria-selected={active} title={doc.kind === 'preview' ? doc.path : `Subagent ${doc.label}`}>
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
