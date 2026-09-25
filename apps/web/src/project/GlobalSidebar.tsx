import type { ReactNode } from 'react'
import { FolderPlus, Settings2 } from 'lucide-react'
import type { SessionSummary } from '../types'
import { folderName, type RecentProject } from '../projectSelection'
import type { ThreadRecord } from './types'
import { threadStateLabel } from './state'

export interface GlobalSidebarProps {
  projects: RecentProject[]
  pinned: readonly string[]
  selectedProjectId: string | null
  onOpenProject: (project: RecentProject) => void
  onTogglePin: (id: string) => void
  onNewProject: () => void
  artifactCount: number
  onOpenArtifacts: () => void
  threads: readonly ThreadRecord[]
  activeThreadId: string | null
  onOpenThread: (id: string) => void
  chats: readonly SessionSummary[]
  selectedChatId: string | null
  onOpenChat: (workspace: string, id: string) => void
  onSettings: () => void
}

/**
 * 应用级侧边栏：Project 是这里的一等公民，其次是它的产物与线程，再往下是普通会话。
 *
 * 只有真实存在的入口出现在这里。`Scheduled` 这一行按参考布局保留位置，但它是禁用的 ——
 * 目前没有定时任务这个能力，放一个点了没反应的按钮比暂时不显示它更糟。
 */
export function GlobalSidebar(props: GlobalSidebarProps) {
  const pinned = props.pinned.length
    ? props.projects.filter(project => props.pinned.includes(project.id))
    : []
  const rest = props.projects.filter(project => !pinned.some(entry => entry.id === project.id))
  const tasks = props.threads.filter(thread => thread.depth > 0)

  return (
    <nav className="global-sidebar" aria-label="Application">
      <button type="button" className="sidebar-action" onClick={props.onNewProject}>
        <FolderPlus size={14} aria-hidden="true" />
        New
      </button>

      <SidebarSection title="Projects">
        {!props.projects.length && <p className="sidebar-empty">A project is a folder you work in.</p>}
        {[...pinned, ...rest].map(project => (
          <button
            key={project.id}
            type="button"
            className="sidebar-item sidebar-project"
            aria-current={project.id === props.selectedProjectId ? 'true' : undefined}
            title={project.workspace}
            onClick={() => props.onOpenProject(project)}
            onContextMenu={event => {
              event.preventDefault()
              props.onTogglePin(project.id)
            }}
          >
            <span className="sidebar-item-name">{project.name}</span>
            <span className="sidebar-item-meta">{folderName(project.workspace)}</span>
          </button>
        ))}
      </SidebarSection>

      <SidebarSection title="Workspace">
        <button
          type="button"
          className="sidebar-item"
          disabled={!props.artifactCount}
          onClick={props.onOpenArtifacts}
        >
          <span className="sidebar-item-name">Artifacts</span>
          <span className="sidebar-item-meta">{props.artifactCount || ''}</span>
        </button>
        <button type="button" className="sidebar-item" disabled title="Not implemented yet">
          <span className="sidebar-item-name">Scheduled</span>
          <span className="sidebar-item-meta">soon</span>
        </button>
        <button type="button" className="sidebar-item" onClick={props.onSettings}>
          <span className="sidebar-item-name">Customize</span>
          <Settings2 size={13} aria-hidden="true" />
        </button>
      </SidebarSection>

      {!!tasks.length && (
        <SidebarSection title="Tasks">
          {tasks.map(thread => (
            <button
              key={thread.id}
              type="button"
              className="sidebar-item"
              aria-current={thread.id === props.activeThreadId ? 'true' : undefined}
              onClick={() => props.onOpenThread(thread.id)}
            >
              <span className="sidebar-item-name">{thread.label}</span>
              <span className="sidebar-item-meta">{threadStateLabel(thread.state)}</span>
            </button>
          ))}
        </SidebarSection>
      )}

      {!!props.chats.length && (
        <SidebarSection title="Chats">
          {props.chats.slice(0, 20).map(chat => (
            <button
              key={`${chat.workspace}:${chat.id}`}
              type="button"
              className="sidebar-item"
              aria-current={chat.id === props.selectedChatId ? 'true' : undefined}
              onClick={() => props.onOpenChat(chat.workspace, chat.id)}
            >
              <span className="sidebar-item-name">{chat.title || 'Untitled'}</span>
            </button>
          ))}
        </SidebarSection>
      )}
    </nav>
  )
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sidebar-group">
      <h2 className="sidebar-group-title">{title}</h2>
      {children}
    </section>
  )
}
