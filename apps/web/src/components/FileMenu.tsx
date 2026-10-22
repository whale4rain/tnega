import { Copy, ExternalLink, FileCode, FolderOpen, Globe, Eye } from 'lucide-react'
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { desktopFiles, fileManagerName } from '../lib/desktop-files'
import { absolutePath, fileOpenKind } from '../lib/file-open'
import { useDismiss } from '../lib/hooks'
import type { MenuItem } from './Menu'

/** What a file reference in the app can do; App provides it around everything. */
export interface FileActions {
  workspace?: string
  /** The click: HTML in the browser, Markdown rendered, office files previewed, the rest in Files. */
  open?: (path: string) => void
  /** Show the file's source in the Files editor. */
  edit?: (path: string) => void
  /** Whether the Workbench browser is available, so HTML opens there. */
  browser?: boolean
}

export const FileActionsContext = createContext<FileActions>({})

/** The click's name for a file, so the menu says what it will do. */
export function openLabel(path: string, browser: boolean): string {
  switch (fileOpenKind(path)) {
    case 'page': return browser ? 'Open in browser' : 'Open in Files'
    case 'markdown': return 'Open preview'
    case 'preview': return 'Open preview'
    case 'text': return 'Open in Files'
  }
}

/** The menu's items for one file, in the order they show. */
export function fileMenuItems(path: string, actions: FileActions, copy: (text: string) => void): Array<MenuItem | 'separator'> {
  const { workspace, open, edit } = actions
  const kind = fileOpenKind(path)
  const desktop = desktopFiles()
  const items: Array<MenuItem | 'separator'> = []
  if (open) {
    const label = openLabel(path, actions.browser === true)
    items.push({ key: 'open', label, icon: label === 'Open in browser' ? <Globe size={14} /> : label === 'Open preview' ? <Eye size={14} /> : <FileCode size={14} />, onSelect: () => open(path) })
  }
  // HTML and Markdown open as a page; their source is one step away.
  if (edit && (kind === 'markdown' || (kind === 'page' && actions.browser === true))) {
    items.push({ key: 'edit', label: 'Edit in Files', icon: <FileCode size={14} />, onSelect: () => edit(path) })
  }
  if (desktop && workspace) {
    if (items.length) items.push('separator')
    items.push(
      { key: 'external', label: 'Open with default app', icon: <ExternalLink size={14} />, onSelect: () => void desktop.open(workspace, path) },
      { key: 'reveal', label: `Show in ${fileManagerName()}`, icon: <FolderOpen size={14} />, onSelect: () => void desktop.reveal(workspace, path) },
    )
  }
  if (items.length) items.push('separator')
  if (workspace) items.push({ key: 'copy', label: 'Copy path', icon: <Copy size={14} />, onSelect: () => copy(absolutePath(workspace, path)) })
  items.push({ key: 'copy-relative', label: 'Copy relative path', icon: <Copy size={14} />, onSelect: () => copy(path) })
  return items
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined)
}

interface Opened {
  path: string
  x: number
  y: number
}

/**
 * The right-click menu on a file anywhere in the app: open it the way a
 * click would, edit its source, hand it to the system's app for that file
 * (desktop), show it in the file manager (desktop), or copy its path.
 * One hook per list; `show` takes the event and the workspace-relative path.
 */
export function useFileMenu(): { show: (event: MouseEvent<HTMLElement>, path: string) => void; menu: ReactNode } {
  const actions = useContext(FileActionsContext)
  const [opened, setOpened] = useState<Opened>()
  // Focus returns here when the menu closes without choosing an item.
  const from = useRef<HTMLElement | null>(null)
  const show = useCallback((event: MouseEvent<HTMLElement>, path: string) => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget
    let { clientX: x, clientY: y } = event
    // From the keyboard (the menu key, Shift+F10) there is no pointer: open under the element.
    if (!x && !y) {
      const rect = target.getBoundingClientRect()
      x = rect.left
      y = rect.bottom
    }
    from.current = target
    setOpened({ path, x, y })
  }, [])
  const close = useCallback((restore: boolean) => {
    setOpened(undefined)
    if (restore) from.current?.focus()
  }, [])
  const menu = opened
    ? <PointMenu key={`${opened.path}:${opened.x}:${opened.y}`} label={`Actions for ${opened.path}`} x={opened.x} y={opened.y} items={fileMenuItems(opened.path, actions, copyText)} onClose={close} />
    : null
  return { show, menu }
}

/** A `Menu` popover placed at a point (the pointer), kept inside the window. */
function PointMenu({ label, x, y, items, onClose }: {
  label: string
  x: number
  y: number
  items: Array<MenuItem | 'separator'>
  onClose: (restoreFocus: boolean) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: x, top: y })
  useDismiss(true, root, () => onClose(true))
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const margin = 8
    setPlace({
      left: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      top: y + rect.height + margin > window.innerHeight ? Math.max(margin, y - rect.height) : y,
    })
    element.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus()
  }, [x, y])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End' && event.key !== 'Tab') return
    event.preventDefault()
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? [])]
    if (!buttons.length) return
    const index = buttons.findIndex(button => button === document.activeElement)
    const last = buttons.length - 1
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? last
        : event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? (index <= 0 ? last : index - 1)
          : (index >= last ? 0 : index + 1)
    buttons[next]?.focus()
  }
  return createPortal(
    <div ref={root} className="menu-popover menu-at-point" role="menu" aria-label={label} style={{ left: place.left, top: place.top }} onKeyDown={onKeyDown} onContextMenu={event => event.preventDefault()}>
      {items.map((item, index) => item === 'separator'
        ? <div key={`sep-${index}`} className="menu-separator" role="separator" />
        : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={`menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={event => {
              event.stopPropagation()
              onClose(false)
              item.onSelect()
            }}
          >
            {item.icon && <span className="menu-item-icon">{item.icon}</span>}
            <span className="menu-item-label">{item.label}</span>
          </button>
        ))}
    </div>,
    document.body,
  )
}
