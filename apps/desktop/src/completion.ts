/** `waiting`: a question or approval needs the user before the run can go on. */
export type CompletionOutcome = 'completed' | 'failed' | 'waiting'

const DESCRIPTION: Record<CompletionOutcome, string> = {
  completed: 'Reply ready',
  failed: 'Session failed',
  waiting: 'Waiting for your answer',
}

interface CompletionWindow<Icon> {
  isDestroyed(): boolean
  isFocused(): boolean
  setOverlayIcon(icon: Icon | null, description: string): void
  on(event: 'focus', listener: () => void): unknown
  removeListener(event: 'focus', listener: () => void): unknown
}

/**
 * Keep an unread weather badge on the taskbar button until the user returns
 * to the window. Deliberately no `flashFrame`: Windows paints the flashing
 * button orange-red, which reads as an alarm. The renderer plays the chime.
 */
export function installCompletionNotice<Icon>(window: CompletionWindow<Icon>, icons: Record<CompletionOutcome, Icon>, platform = process.platform) {
  const clear = () => {
    if (window.isDestroyed()) return
    if (platform === 'win32') window.setOverlayIcon(null, '')
  }
  window.on('focus', clear)
  return {
    notify(outcome: unknown): void {
      if ((outcome !== 'completed' && outcome !== 'failed' && outcome !== 'waiting') || window.isDestroyed()) return
      if (window.isFocused()) return
      if (platform === 'win32') window.setOverlayIcon(icons[outcome], DESCRIPTION[outcome])
    },
    dispose(): void {
      window.removeListener('focus', clear)
      clear()
    },
  }
}
