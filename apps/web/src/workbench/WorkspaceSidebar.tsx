import { useState } from 'react'
import {
  Button,
  Dialog,
  DropdownMenu,
  IconButton,
  SegmentedControl,
  TextField,
  Tooltip,
} from '@radix-ui/themes'
import {
  Code2,
  LayoutList,
  MessageSquare,
  Plus,
  Search,
  Settings,
  SunMoon,
} from 'lucide-react'
import type { SessionSummary } from '../types'
import type { ThemePreference } from '../ThemeToggle'
import { WorkspaceTree } from './WorkspaceTree'
import {
  hasDesktopWorkspacePicker,
  pickDesktopWorkspace,
} from '../desktopBridge'

interface Props {
  workspaces: string[]
  workspace: string | null
  sessions: SessionSummary[]
  selectedId: string | null
  onAdd: (path: string) => Promise<void>
  onRemove: (path: string) => Promise<void>
  onSelect: (workspace: string, id: string) => void
  onNew: (
    options: { agentType: 'general' | 'coding' },
    workspace?: string,
  ) => Promise<void>
  onRename: (workspace: string, id: string, title: string) => Promise<void>
  onFork: (workspace: string, id: string) => Promise<void>
  onDelete: (workspace: string, id: string) => Promise<void>
  onSettings: () => void
  theme: ThemePreference
  onTheme: (theme: ThemePreference) => void
  /** 主区显示会话流还是 Project 屏。 */
  view: 'sessions' | 'projects'
  onView: (view: 'sessions' | 'projects') => void
}

export function WorkspaceSidebar(props: Props) {
  const [agent, setAgent] = useState<'coding' | 'general'>('coding')
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [rename, setRename] = useState<SessionSummary | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="sidebar-top flex flex-col">
        <SegmentedControl.Root
          size="1"
          value={props.view}
          onValueChange={(value) => {
            if (value === 'sessions' || value === 'projects') props.onView(value)
          }}
          aria-label="Workspace view"
        >
          <SegmentedControl.Item value="sessions">
            <span className="flex items-center gap-2">
              <MessageSquare size={15} /> Sessions
            </span>
          </SegmentedControl.Item>
          <SegmentedControl.Item value="projects">
            <span className="flex items-center gap-2">
              <LayoutList size={15} /> Project
            </span>
          </SegmentedControl.Item>
        </SegmentedControl.Root>
        <SegmentedControl.Root
          size="1"
          value={agent}
          onValueChange={(value) => {
            if (value === 'coding' || value === 'general') setAgent(value)
          }}
          aria-label="New session type"
        >
          <SegmentedControl.Item value="general">
            <span className="flex items-center gap-2">
              <MessageSquare size={15} /> Chat
            </span>
          </SegmentedControl.Item>
          <SegmentedControl.Item value="coding">
            <span className="flex items-center gap-2">
              <Code2 size={15} /> Code
            </span>
          </SegmentedControl.Item>
        </SegmentedControl.Root>
        <Button
          color="gray"
          variant="ghost"
          onClick={() => void perform(() => props.onNew({ agentType: agent }))}
          disabled={!props.workspace || busy}
        >
          <Plus size={16} /> New session
        </Button>
        <TextField.Root
          aria-label="Search sessions"
          placeholder="Search sessions…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        >
          <TextField.Slot>
            <Search size={15} />
          </TextField.Slot>
        </TextField.Root>
      </div>
      <div className="sidebar-section-label flex items-center justify-between">
        <span>Projects</span>
        <Tooltip content="Add workspace">
          <IconButton
            variant="ghost"
            color="gray"
            aria-label="Add workspace"
            onClick={() => setAdding(true)}
          >
            <Plus size={16} />
          </IconButton>
        </Tooltip>
      </div>
      <WorkspaceTree
        workspaces={props.workspaces}
        workspace={props.workspace}
        sessions={props.sessions}
        selectedId={props.selectedId}
        search={search}
        busy={busy}
        onSelect={props.onSelect}
        onNew={(workspace) =>
          void perform(() => props.onNew({ agentType: agent }, workspace))
        }
        onRemove={(workspace) => void perform(() => props.onRemove(workspace))}
        onRename={(session) => {
          setRename(session)
          setTitle(session.title)
        }}
        onFork={(workspace, id) =>
          void perform(() => props.onFork(workspace, id))
        }
        onDelete={(workspace, id) => {
          const target = props.sessions.find(session => session.workspace === workspace && session.id === id)
          if (target) setDeleteTarget(target)
        }}
      />
      {error && (
        <p role="alert" className="sidebar-hint danger">
          {error}
        </p>
      )}
      <footer className="sidebar-footer flex items-center justify-between">
        <Button variant="ghost" color="gray" onClick={props.onSettings}>
          <Settings size={16} /> Settings
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton aria-label="Appearance" variant="ghost" color="gray">
              <SunMoon size={16} />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.RadioGroup
              value={props.theme}
              onValueChange={(value) => {
                if (value === 'light' || value === 'dark' || value === 'system')
                  props.onTheme(value)
              }}
            >
              {(['light', 'dark', 'system'] as const).map((value) => (
                <DropdownMenu.RadioItem key={value} value={value}>
                  {value}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </footer>
      <Dialog.Root
        open={adding}
        onOpenChange={(open) => {
          setAdding(open)
          setError('')
        }}
      >
        <Dialog.Content maxWidth="440px">
          <Dialog.Title>Add workspace</Dialog.Title>
          <Dialog.Description size="2" mb="4">
            Choose the local project you want to work on.
          </Dialog.Description>
          {error && (
            <p role="alert" className="danger">
              {error}
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (path.trim())
                void perform(async () => {
                  await props.onAdd(path.trim())
                  setAdding(false)
                  setPath('')
                })
            }}
          >
            <TextField.Root
              aria-label="Workspace path"
              placeholder="Absolute project path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
            <div className="flex justify-end gap-3 mt-4">
              <Dialog.Close>
                <Button variant="soft" color="gray">
                  Cancel
                </Button>
              </Dialog.Close>
              {hasDesktopWorkspacePicker() && (
                <Button
                  type="button"
                  variant="soft"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const selected = await pickDesktopWorkspace()
                      if (selected) setPath(selected)
                    })
                  }
                >
                  Browse…
                </Button>
              )}
              <Button type="submit" disabled={busy || !path.trim()}>
                Add workspace
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Root>
      <Dialog.Root open={deleteTarget !== null} onOpenChange={open => { if (!open && !busy) setDeleteTarget(null) }}>
        <Dialog.Content maxWidth="420px">
          <Dialog.Title>Delete session?</Dialog.Title>
          <Dialog.Description size="2" mb="4">
            Delete “{deleteTarget?.title || 'Untitled session'}” and its conversation history?
          </Dialog.Description>
          {error && <p role="alert" className="danger">{error}</p>}
          <div className="flex justify-end gap-3 mt-4">
            <Button variant="soft" color="gray" disabled={busy} onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button color="red" disabled={busy} onClick={() => {
              if (!deleteTarget) return
              void perform(async () => {
                await props.onDelete(deleteTarget.workspace, deleteTarget.id)
                setDeleteTarget(null)
              })
            }}>Delete session</Button>
          </div>
        </Dialog.Content>
      </Dialog.Root>
      <Dialog.Root
        open={rename !== null}
        onOpenChange={(open) => {
          if (!open) setRename(null)
        }}
      >
        <Dialog.Content maxWidth="420px">
          <Dialog.Title>Rename session</Dialog.Title>
          <Dialog.Description size="2" mb="4">
            Give this conversation a recognizable name.
          </Dialog.Description>
          {error && (
            <p role="alert" className="danger">
              {error}
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (rename && title.trim())
                void perform(async () => {
                  await props.onRename(
                    rename.workspace,
                    rename.id,
                    title.trim(),
                  )
                  setRename(null)
                })
            }}
          >
            <TextField.Root
              aria-label="Session name"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="flex justify-end gap-3 mt-4">
              <Dialog.Close>
                <Button variant="soft" color="gray">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={busy || !title.trim()}>
                Save
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Root>
    </>
  )
}
