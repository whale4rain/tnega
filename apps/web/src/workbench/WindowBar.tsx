import { IconButton, Tooltip } from '@radix-ui/themes'
import { Code2, LayoutList, PanelLeft } from 'lucide-react'

/**
 * 顶部窗口条：Electron 的拖动区域，也是「现在在哪一屏」的一行说明。
 *
 * 会话屏与 Project 屏各有一个壳，但这一条是同一份 —— 拖动区域和品牌不该有两套实现。
 */
export function WindowBar({
  caption,
  icon,
  sidebarOpen,
  onToggleSidebar,
}: {
  caption: string
  icon: 'code' | 'project'
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
}) {
  const Icon = icon === 'project' ? LayoutList : Code2
  return (
    <header className="window-bar flex items-center gap-3">
      {onToggleSidebar && (
        <Tooltip content={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}>
          <IconButton
            variant="ghost"
            color="gray"
            aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={sidebarOpen}
            aria-controls="workspace-navigation"
            onClick={onToggleSidebar}
          >
            <PanelLeft size={15} />
          </IconButton>
        </Tooltip>
      )}
      <span className="brand">Tnega</span>
      <span className="window-divider" />
      <span className="window-caption">
        <Icon size={12} /> {caption}
      </span>
    </header>
  )
}
