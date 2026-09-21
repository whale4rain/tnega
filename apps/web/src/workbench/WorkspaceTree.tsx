import { useState } from 'react'
import { DropdownMenu, IconButton } from '@radix-ui/themes'
import { ChevronRight, FolderOpen, MoreHorizontal, Plus } from 'lucide-react'
import type { SessionSummary } from '../types'
import { workspaceName } from './workspace'

interface Props {
  workspaces: string[]
  workspace: string | null
  sessions: SessionSummary[]
  selectedId: string | null
  search: string
  busy: boolean
  onSelect: (workspace: string, id: string) => void
  onNew: (workspace: string) => void
  onRemove: (workspace: string) => void
  onRename: (session: SessionSummary) => void
  onFork: (workspace: string, id: string) => void
  onDelete: (workspace: string, id: string) => void
}

export function WorkspaceTree(props: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const query = props.search.trim().toLowerCase()
  const groups = props.workspaces
    .map((path) => ({
      path,
      name: workspaceName(path),
      sessions: props.sessions.filter(
        (session) =>
          session.workspace === path &&
          (!query ||
            session.title.toLowerCase().includes(query) ||
            workspaceName(path).toLowerCase().includes(query)),
      ),
    }))
    .filter(
      (group) =>
        !query ||
        group.sessions.length > 0 ||
        group.name.toLowerCase().includes(query),
    )

  return (
    <nav className="session-list" aria-label="Sessions">
      {groups.map(({ path, name, sessions }) => {
        const open = !!query || !collapsed.has(path)
        return (
          <section className="workspace-group" aria-label={path} key={path}>
            <div className="workspace-heading">
              <button
                className="workspace-toggle"
                title={path}
                aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}
                aria-expanded={open}
                onClick={() => {
                  setCollapsed((current) => {
                    const next = new Set(current)
                    if (next.has(path)) next.delete(path)
                    else next.add(path)
                    return next
                  })
                }}
              >
                <span className="workspace-folder">
                  <FolderOpen size={15} />
                  <ChevronRight size={14} className={open ? 'expanded' : ''} />
                </span>
                <span className="truncate">{name}</span>
              </button>
              <IconButton
                className="workspace-action"
                variant="ghost"
                color="gray"
                size="1"
                aria-label={`New session in ${name}`}
                disabled={props.busy}
                onClick={() => props.onNew(path)}
              >
                <Plus size={14} />
              </IconButton>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <IconButton
                    className="workspace-action"
                    variant="ghost"
                    color="gray"
                    size="1"
                    aria-label={`Actions for workspace ${name}`}
                  >
                    <MoreHorizontal size={14} />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content>
                  <DropdownMenu.Item
                    color="red"
                    disabled={props.busy}
                    onSelect={() => props.onRemove(path)}
                  >
                    Remove from list
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
            {open &&
              sessions.map((session) => {
                const selected =
                  path === props.workspace && session.id === props.selectedId
                return (
                  <div
                    key={session.id}
                    className={`session-item${selected ? ' selected' : ''}`}
                  >
                    <button
                      className="session-link"
                      onClick={() => props.onSelect(path, session.id)}
                      aria-current={selected ? 'page' : undefined}
                      title={session.title}
                    >
                      <span className="truncate">
                        {session.title || 'Untitled session'}
                      </span>
                    </button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger>
                        <IconButton
                          variant="ghost"
                          color="gray"
                          size="1"
                          aria-label={`Actions for ${session.title}`}
                        >
                          <MoreHorizontal size={16} />
                        </IconButton>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content>
                        <DropdownMenu.Item
                          disabled={props.busy}
                          onSelect={() => props.onRename(session)}
                        >
                          Rename…
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          disabled={props.busy}
                          onSelect={() => props.onFork(path, session.id)}
                        >
                          Fork session
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          disabled={props.busy}
                          color="red"
                          onSelect={() => props.onDelete(path, session.id)}
                        >
                          Delete session…
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  </div>
                )
              })}
          </section>
        )
      })}
      {!props.workspaces.length && (
        <p className="sidebar-hint">Add a workspace to get started.</p>
      )}
      {!!query && !groups.length && (
        <p className="sidebar-hint">No matching sessions.</p>
      )}
    </nav>
  )
}
