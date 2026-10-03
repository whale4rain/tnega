export type CompletionOutcome = 'completed' | 'failed'

interface CompletionWindow<Icon> {
  isDestroyed(): boolean
  isFocused(): boolean
  setOverlayIcon(icon: Icon | null, description: string): void
  flashFrame(flag: boolean): void
  on(event: 'focus', listener: () => void): unknown
  removeListener(event: 'focus', listener: () => void): unknown
}

/** Keep unread completion badges until the user returns to the window. */
export function installCompletionNotice<Icon>(window: CompletionWindow<Icon>, icons: Record<CompletionOutcome, Icon>, beep: () => void, platform = process.platform) {
  const clear = () => {
    if (window.isDestroyed()) return
    window.flashFrame(false)
    if (platform === 'win32') window.setOverlayIcon(null, '')
  }
  window.on('focus', clear)
  return {
    notify(outcome: unknown): void {
      if ((outcome !== 'completed' && outcome !== 'failed') || window.isDestroyed()) return
      beep()
      if (window.isFocused()) return
      if (platform === 'win32') window.setOverlayIcon(icons[outcome], outcome === 'failed' ? 'Session failed' : 'Reply ready')
      window.flashFrame(true)
    },
    dispose(): void {
      window.removeListener('focus', clear)
      clear()
    },
  }
}
