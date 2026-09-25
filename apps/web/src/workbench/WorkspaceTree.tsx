import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu'
import { HStack } from '@astryxdesign/core/Layout'
import { TreeList, type TreeListItemData } from '@astryxdesign/core/TreeList'
import { IconButton } from '@astryxdesign/core/IconButton'
import { FolderOpen, MoreHorizontal, Plus } from 'lucide-react'
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

function ActionsMenu({
  label,
  items,
}: {
  label: string
  items: DropdownMenuOption[]
}) {
  return (
    <DropdownMenu
      button={{ label, icon: <MoreHorizontal size={15} />, variant: 'ghost', size: 'sm' }}
      hasChevron={false}
      items={items}
    />
  )
}

export function WorkspaceTree(props: Props) {
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

  const items: TreeListItemData[] = groups.map(({ path, name, sessions }) => ({
    id: path,
    label: name,
    description: path,
    startContent: <FolderOpen size={15} aria-hidden="true" />,
    isExpanded: true,
    endContent: (
      <HStack gap={1}>
        <IconButton
          label={`New session in ${name}`}
          icon={<Plus size={14} />}
          variant="ghost"
          size="sm"
          isDisabled={props.busy}
          onClick={(event) => {
            event.stopPropagation()
            props.onNew(path)
          }}
        />
        <ActionsMenu
          label={`Actions for workspace ${name}`}
          items={[
            {
              label: 'Remove from list',
              isDisabled: props.busy,
              variant: 'destructive',
              onClick: () => props.onRemove(path),
            },
          ]}
        />
      </HStack>
    ),
    children: sessions.map((session) => ({
      id: `${path}:${session.id}`,
      label: session.title || 'Untitled session',
      isSelected: path === props.workspace && session.id === props.selectedId,
      onClick: () => props.onSelect(path, session.id),
      endContent: (
        <ActionsMenu
          label={`Actions for ${session.title || 'Untitled session'}`}
          items={[
            {
              label: 'Rename…',
              isDisabled: props.busy,
              onClick: () => props.onRename(session),
            },
            {
              label: 'Fork session',
              isDisabled: props.busy,
              onClick: () => props.onFork(path, session.id),
            },
            { type: 'divider' },
            {
              label: 'Delete session…',
              isDisabled: props.busy,
              variant: 'destructive' as const,
              onClick: () => props.onDelete(path, session.id),
            },
          ]}
        />
      ),
    })),
  }))

  return (
    <>
      {items.length > 0 && (
        <TreeList key={query} items={items} density="compact" variant="noGuides" />
      )}
      {!props.workspaces.length && (
        <p className="sidebar-hint">Add a workspace to get started.</p>
      )}
      {!!query && !groups.length && (
        <p className="sidebar-hint">No matching sessions.</p>
      )}
    </>
  )
}
