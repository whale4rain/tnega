import { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { DropdownMenu, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@astryxdesign/core/DropdownMenu'
import { IconButton } from '@astryxdesign/core/IconButton'
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from '@astryxdesign/core/Layout'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import {
  Code2,
  Archive,
  ArchiveRestore,
  FolderPlus,
  LayoutList,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  SunMoon,
  Trash2,
} from 'lucide-react'
import type { SessionSummary } from '../types'
import { folderName, type RecentProject } from '../projectSelection'
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
  /** 最近打开的 Project；选中它就进入 Project 屏，选中会话则回到会话屏。 */
  projects: RecentProject[]
  selectedProjectId: string | null
  onOpenProject: (project: RecentProject) => void
  onNewProject: () => void
  onArchiveProject: (project: RecentProject, archived: boolean) => Promise<void>
  onDeleteProject: (project: RecentProject) => Promise<void>
}

export function WorkspaceSidebar(props: Props) {
  const [agent, setAgent] = useState<'coding' | 'general'>('coding')
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [rename, setRename] = useState<SessionSummary | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null)
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<RecentProject | null>(null)
  const [showArchivedProjects, setShowArchivedProjects] = useState(false)
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
        <SegmentedControl
          size="sm"
          value={agent}
          onChange={(value) => {
            if (value === 'coding' || value === 'general') setAgent(value)
          }}
          label="New session type"
        >
          <SegmentedControlItem value="general" label="Chat" icon={<MessageSquare size={15} />} />
          <SegmentedControlItem value="coding" label="Code" icon={<Code2 size={15} />} />
        </SegmentedControl>
        <Button
          variant="ghost"
          label="New session"
          icon={<Plus size={16} />}
          size="md"
          onClick={() => void perform(() => props.onNew({ agentType: agent }))}
          isDisabled={!props.workspace || busy}
        />
        <TextInput
          label="Search sessions"
          isLabelHidden
          startIcon={<Search size={15} />}
          placeholder="Search sessions…"
          value={search}
          onChange={setSearch}
        />
      </div>
      <div className="sidebar-section-label flex items-center justify-between">
        <span>Projects</span>
        <Tooltip content="New project">
          <IconButton
            variant="ghost"
            label="New project"
            icon={<FolderPlus size={16} />}
            onClick={props.onNewProject}
          />
        </Tooltip>
      </div>
      {props.projects.some(project => !project.archived) ? (
        <ul className="project-list" aria-label="Projects">
          {props.projects.filter(project => !project.archived).map(project => (
            <li key={project.id}>
              <div className="project-row-wrap">
                <button
                  type="button"
                  className="project-row"
                  aria-current={project.id === props.selectedProjectId ? 'true' : undefined}
                  onClick={() => props.onOpenProject(project)}
                  title={project.workspace}
                >
                  <LayoutList size={15} aria-hidden="true" />
                  <span className="project-row-body">
                    <span className="project-row-name">{project.name}</span>
                    <span className="project-row-folder">{folderName(project.workspace)}</span>
                  </span>
                </button>
                <DropdownMenu
                  button={{ label: `Project actions: ${project.name}`, icon: <MoreHorizontal size={15} />, variant: 'ghost', isIconOnly: true, size: 'sm' }}
                  hasChevron={false}
                  alignment="end"
                  items={[
                    { label: 'Archive project', icon: <Archive size={14} />, onClick: () => void perform(() => props.onArchiveProject(project, true)) },
                    { type: 'divider' },
                    { label: 'Delete project…', icon: <Trash2 size={14} />, variant: 'destructive', onClick: () => setProjectDeleteTarget(project) },
                  ]}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sidebar-hint">No active projects.</p>
      )}
      {props.projects.some(project => project.archived) && (
        <>
          <button type="button" className="sidebar-section-label archived-project-toggle" onClick={() => setShowArchivedProjects(value => !value)}>
            {showArchivedProjects ? 'Hide archived' : `Archived (${props.projects.filter(project => project.archived).length})`}
          </button>
          {showArchivedProjects && (
            <ul className="project-list" aria-label="Archived projects">
              {props.projects.filter(project => project.archived).map(project => (
                <li key={project.id}>
                  <div className="project-row-wrap">
                    <button type="button" className="project-row" onClick={() => props.onOpenProject(project)} title={project.workspace}>
                      <LayoutList size={15} aria-hidden="true" />
                      <span className="project-row-body">
                        <span className="project-row-name">{project.name}</span>
                        <span className="project-row-folder">{folderName(project.workspace)}</span>
                      </span>
                    </button>
                    <DropdownMenu
                      button={{ label: `Project actions: ${project.name}`, icon: <MoreHorizontal size={15} />, variant: 'ghost', isIconOnly: true, size: 'sm' }}
                      hasChevron={false}
                      alignment="end"
                      items={[
                        { label: 'Restore project', icon: <ArchiveRestore size={14} />, onClick: () => void perform(() => props.onArchiveProject(project, false)) },
                        { type: 'divider' },
                        { label: 'Delete project…', icon: <Trash2 size={14} />, variant: 'destructive', onClick: () => setProjectDeleteTarget(project) },
                      ]}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="sidebar-section-label flex items-center justify-between">
        <span>Workspaces</span>
        <Tooltip content="Add workspace">
          <IconButton
            variant="ghost"
            label="Add workspace"
            icon={<Plus size={16} />}
            onClick={() => setAdding(true)}
          />
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
      <footer className="sidebar-footer">
        <Button label="Settings" icon={<Settings size={16} />} variant="ghost" onClick={props.onSettings} />
        <DropdownMenu
          button={{ label: 'Appearance', icon: <SunMoon size={16} />, variant: 'ghost', isIconOnly: true }}
          hasChevron={false}
        >
          <DropdownMenuRadioGroup value={props.theme} label="Appearance" onChange={value => {
            if (value === 'light' || value === 'dark' || value === 'system') props.onTheme(value)
          }}>
            {(['light', 'dark', 'system'] as const).map(value => (
              <DropdownMenuRadioItem key={value} value={value} label={value} />
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenu>
      </footer>
      <Dialog isOpen={adding} onOpenChange={open => { setAdding(open); setError('') }} purpose="form" width={440}>
        <Layout
          height="auto"
          header={<DialogHeader title="Add workspace" subtitle="Choose the local project you want to work on." onOpenChange={() => setAdding(false)} />}
          content={
            <LayoutContent>
              <form onSubmit={event => {
                event.preventDefault()
                if (path.trim()) void perform(async () => {
                  await props.onAdd(path.trim())
                  setAdding(false)
                  setPath('')
                })
              }}>
                <VStack gap={3}>
                  <TextInput label="Workspace path" placeholder="Absolute project path" value={path} onChange={setPath} />
                  {error && <Text role="alert" className="danger" type="body">{error}</Text>}
                  <LayoutFooter>
                    <HStack gap={2} hAlign="end">
                      <Button label="Cancel" variant="secondary" onClick={() => setAdding(false)} />
                      {hasDesktopWorkspacePicker() && <Button label="Browse…" variant="secondary" isDisabled={busy} onClick={() => void perform(async () => {
                        const selected = await pickDesktopWorkspace()
                        if (selected) setPath(selected)
                      })} />}
                      <Button label="Add workspace" type="submit" isDisabled={busy || !path.trim()} />
                    </HStack>
                  </LayoutFooter>
                </VStack>
              </form>
            </LayoutContent>
          }
        />
      </Dialog>
      <Dialog isOpen={deleteTarget !== null} onOpenChange={open => { if (!open && !busy) setDeleteTarget(null) }} purpose="form" width={420}>
        <Layout
          height="auto"
          header={<DialogHeader title="Delete session?" onOpenChange={() => !busy && setDeleteTarget(null)} />}
          content={<LayoutContent><VStack gap={3}>
            <Text type="body">Delete “{deleteTarget?.title || 'Untitled session'}” and its conversation history?</Text>
            {error && <Text role="alert" className="danger" type="body">{error}</Text>}
          </VStack></LayoutContent>}
          footer={<LayoutFooter><HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="secondary" isDisabled={busy} onClick={() => setDeleteTarget(null)} />
            <Button label="Delete session" variant="destructive" isDisabled={busy} onClick={() => {
              if (!deleteTarget) return
              void perform(async () => {
                await props.onDelete(deleteTarget.workspace, deleteTarget.id)
                setDeleteTarget(null)
              })
            }} />
          </HStack></LayoutFooter>}
        />
      </Dialog>
      <Dialog isOpen={projectDeleteTarget !== null} onOpenChange={open => { if (!open && !busy) setProjectDeleteTarget(null) }} purpose="form" width={440}>
        <Layout
          height="auto"
          header={<DialogHeader title="Delete project permanently?" onOpenChange={() => !busy && setProjectDeleteTarget(null)} />}
          content={<LayoutContent><VStack gap={3}>
            <Text type="body">Delete “{projectDeleteTarget?.name}” and all its project data? This cannot be undone.</Text>
            {error && <Text role="alert" className="danger" type="body">{error}</Text>}
          </VStack></LayoutContent>}
          footer={<LayoutFooter><HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="secondary" isDisabled={busy} onClick={() => setProjectDeleteTarget(null)} />
            <Button label="Delete project" variant="destructive" isDisabled={busy} onClick={() => {
              if (!projectDeleteTarget) return
              void perform(async () => {
                await props.onDeleteProject(projectDeleteTarget)
                setProjectDeleteTarget(null)
              })
            }} />
          </HStack></LayoutFooter>}
        />
      </Dialog>
      <Dialog isOpen={rename !== null} onOpenChange={open => { if (!open) setRename(null) }} purpose="form" width={420}>
        <Layout
          height="auto"
          header={<DialogHeader title="Rename session" subtitle="Give this conversation a recognizable name." onOpenChange={() => setRename(null)} />}
          content={
            <LayoutContent>
              <form onSubmit={event => {
                event.preventDefault()
                if (rename && title.trim()) void perform(async () => {
                  await props.onRename(rename.workspace, rename.id, title.trim())
                  setRename(null)
                })
              }}>
                <VStack gap={3}>
                  <TextInput label="Session name" value={title} onChange={setTitle} />
                  {error && <Text role="alert" className="danger" type="body">{error}</Text>}
                  <LayoutFooter><HStack gap={2} hAlign="end">
                    <Button label="Cancel" variant="secondary" onClick={() => setRename(null)} />
                    <Button label="Save" type="submit" isDisabled={busy || !title.trim()} />
                  </HStack></LayoutFooter>
                </VStack>
              </form>
            </LayoutContent>
          }
        />
      </Dialog>
    </>
  )
}
