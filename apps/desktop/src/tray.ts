import { Menu, Tray } from 'electron'

interface TrayWindow {
  on(event: 'minimize', listener: () => void): unknown
  removeListener(event: 'minimize', listener: () => void): unknown
  hide(): void
  show(): void
  restore(): void
  focus(): void
  isMinimized(): boolean
}

export function installTray(window: TrayWindow, icon: string, quit: () => void) {
  const tray = new Tray(icon)
  const hide = () => window.hide()
  const restore = () => {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  tray.setToolTip('Tnega')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Tnega', click: restore },
    { type: 'separator' },
    { label: 'Exit Tnega', click: quit },
  ]))
  tray.on('click', restore)
  window.on('minimize', hide)
  return {
    tray,
    dispose: () => {
      window.removeListener('minimize', hide)
      tray.removeAllListeners()
      tray.destroy()
    },
  }
}
