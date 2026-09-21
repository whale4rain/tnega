import { useEffect, useState, type ReactNode } from 'react'
import { Badge, IconButton, Tooltip } from '@radix-ui/themes'
import { Code2, Files, GitBranch, PanelLeft, Terminal, X } from 'lucide-react'

const tools = [
  {
    id: 'files',
    title: 'Files',
    icon: Files,
    description: 'Browse workspace files alongside your conversation.',
  },
  {
    id: 'changes',
    title: 'Changes',
    icon: GitBranch,
    description: 'Review agent changes and diffs here.',
  },
  {
    id: 'terminal',
    title: 'Terminal',
    icon: Terminal,
    description: 'Inspect command output without leaving your conversation.',
  },
] as const

export function WorkbenchShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem('tnega-sidebar')
    return stored ? stored !== 'closed' : window.innerWidth > 760
  })
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const tool = tools.find((item) => item.id === activeTool)
  useEffect(() => {
    localStorage.setItem('tnega-sidebar', open ? 'open' : 'closed')
  }, [open])
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setActiveTool(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="workbench">
      <header className="window-bar flex items-center gap-3">
        <Tooltip content={open ? 'Collapse sidebar' : 'Expand sidebar'}>
          <IconButton
            variant="ghost"
            color="gray"
            aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={open}
            aria-controls="workspace-navigation"
            onClick={() => setOpen(!open)}
          >
            <PanelLeft size={18} />
          </IconButton>
        </Tooltip>
        <span className="brand">Tnega</span>
        <span className="window-divider" />
        <span className="window-caption">
          <Code2 size={14} /> Code workspace
        </span>
      </header>
      <div className="workbench-body flex min-h-0 flex-1">
        {open && (
          <button
            className="sidebar-backdrop"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          />
        )}
        <aside
          id="workspace-navigation"
          className={`workspace-sidebar${open ? '' : ' collapsed'}`}
          aria-label="Workspace navigation"
          aria-hidden={!open}
          inert={!open}
        >
          <div className="sidebar-content">{sidebar}</div>
        </aside>
        <main className="main min-w-0 flex-1">{children}</main>
        {tool && (
          <aside className="tools-panel" aria-label={`${tool.title} panel`}>
            <div className="flex items-center justify-between gap-2 tool-panel-heading">
              <strong>{tool.title}</strong>
              <IconButton
                variant="ghost"
                color="gray"
                aria-label="Close tools panel"
                onClick={() => setActiveTool(null)}
              >
                <X size={16} />
              </IconButton>
            </div>
            <div className="tool-placeholder">
              <tool.icon size={32} strokeWidth={1.2} />
              <h2>{tool.title}</h2>
              <p>{tool.description}</p>
              <Badge color="gray" variant="soft">
                Coming soon
              </Badge>
              <p className="text-xs">
                This panel is a placeholder. No tools are connected yet.
              </p>
            </div>
          </aside>
        )}
        <nav
          className="tools-rail flex flex-col items-center gap-3"
          aria-label="Workspace tools"
        >
          {tools.map((item) => (
            <Tooltip content={item.title} key={item.id}>
              <IconButton
                variant={activeTool === item.id ? 'soft' : 'ghost'}
                color="gray"
                aria-label={`Toggle ${item.title}`}
                aria-pressed={activeTool === item.id}
                onClick={() =>
                  setActiveTool(activeTool === item.id ? null : item.id)
                }
              >
                <item.icon size={18} />
              </IconButton>
            </Tooltip>
          ))}
        </nav>
      </div>
    </div>
  )
}
