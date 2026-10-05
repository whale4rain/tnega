/**
 * Clipboard keys for the workbench terminal, as Windows Terminal and VS Code
 * do it: Ctrl+C copies when text is selected and interrupts otherwise;
 * Ctrl+Shift+C / Ctrl+Shift+V always copy / paste, and Ctrl+V pastes.
 * Ctrl+Insert / Shift+Insert are the older equivalents.
 */
export type TerminalClipboardKey = 'copy' | 'paste'

export interface TerminalKey {
  type: string
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export function terminalClipboardKey(event: TerminalKey, hasSelection: boolean): TerminalClipboardKey | undefined {
  if (event.type !== 'keydown' || event.altKey) return undefined
  const key = event.key.toLowerCase()
  // Cmd+C / Cmd+V on macOS.
  if (event.metaKey && !event.ctrlKey) return key === 'c' && hasSelection ? 'copy' : key === 'v' ? 'paste' : undefined
  if (key === 'insert') return event.ctrlKey && !event.shiftKey && hasSelection ? 'copy' : event.shiftKey && !event.ctrlKey ? 'paste' : undefined
  if (!event.ctrlKey || event.metaKey) return undefined
  if (key === 'c') return event.shiftKey || hasSelection ? 'copy' : undefined
  if (key === 'v') return 'paste'
  return undefined
}
