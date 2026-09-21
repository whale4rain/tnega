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
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  SunMoon,
} from 'lucide-react'
import type { SessionSummary } from '../types'
import type { ThemePreference } from '../ThemeToggle'
import { workspaceName } from './workspace'
import {
  hasDesktopWorkspacePicker,
  pickDesktopWorkspace,
} from '../desktopBridge'

interface Props {
  workspaces: string[]
  workspace: string | null
  sessions: SessionSummary[]
  selectedId: string | null
  onWorkspace: (path: string) => void
  onAdd: (path: string) => Promise<void>
  onRemove: (path: string) => Promise<void>
  onSelect: (id: string) => void
  onNew: (options: { agentType: 'general' | 'coding' }) => Promise<void>
  onRename: (id: string, title: string) => Promise<void>
  onFork: (id: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onSettings: () => void
  theme: ThemePreference
  onTheme: (theme: ThemePreference) => void
}

export function WorkspaceSidebar(props: Props) {
  const [agent, setAgent] = useState<'coding' | 'general'>('coding')
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [rename, setRename] = useState<SessionSummary | null>(null)
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
      <div className="sidebar-section-label">Projects</div>
      <div className="sidebar-project flex items-center justify-between gap-2">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Button variant="ghost" color="gray" className="project-trigger">
              <FolderOpen size={15} />
              <span className="truncate">
                {props.workspace
                  ? workspaceName(props.workspace)
                  : 'Workspaces'}
              </span>
              <DropdownMenu.TriggerIcon />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            {props.workspaces.map((item) => (
              <DropdownMenu.Item
                key={item}
                onSelect={() => props.onWorkspace(item)}
              >
                {item}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator />
            <DropdownMenu.Item onSelect={() => setAdding(true)}>
              Add workspace…
            </DropdownMenu.Item>
            {props.workspace && (
              <DropdownMenu.Item
                color="red"
                onSelect={() => {
                  if (props.workspace)
                    void perform(() => props.onRemove(props.workspace!))
                }}
              >
                Remove from list
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
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
      <nav className="session-list" aria-label="Sessions">
        {props.sessions
          .filter((session) =>
            session.title.toLowerCase().includes(search.toLowerCase()),
          )
          .map((session) => (
            <div
              key={session.id}
              className={`session-item ${session.id === props.selectedId ? 'selected' : ''}`}
            >
              <button
                className="session-link"
                onClick={() => props.onSelect(session.id)}
                aria-current={
                  session.id === props.selectedId ? 'page' : undefined
                }
                title={session.title}
              >
                <span className="session-dot" />
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
                    onSelect={() => {
                      setRename(session)
                      setTitle(session.title)
                    }}
                  >
                    Rename…
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() =>
                      void perform(() => props.onFork(session.id))
                    }
                  >
                    Fork session
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    color="red"
                    onSelect={() =>
                      void perform(() => props.onDelete(session.id))
                    }
                  >
                    Delete session…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
          ))}
        {!props.sessions.length && (
          <p className="sidebar-hint">
            {props.workspace
              ? 'Start a session to explore your code.'
              : 'Add a workspace to get started.'}
          </p>
        )}
        {props.sessions.length > 0 &&
          !props.sessions.some((session) =>
            session.title.toLowerCase().includes(search.toLowerCase()),
          ) && <p className="sidebar-hint">No matching sessions.</p>}
      </nav>
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
      <Dialog.Root open={adding} onOpenChange={open => { setAdding(open); setError('') }}>
        <Dialog.Content maxWidth="440px">
          <Dialog.Title>Add workspace</Dialog.Title>
          <Dialog.Description size="2" mb="4">
            Choose the local project you want to work on.
          </Dialog.Description>
          {error && <p role="alert" className="danger">{error}</p>}
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
          {error && <p role="alert" className="danger">{error}</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (rename && title.trim())
                void perform(async () => {
                  await props.onRename(rename.id, title.trim())
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
