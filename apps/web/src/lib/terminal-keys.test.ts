import { describe, expect, it } from 'vitest'
import { terminalClipboardKey, type TerminalKey } from './terminal-keys'

const key = (name: string, modifiers: Partial<TerminalKey> = {}): TerminalKey => ({
  type: 'keydown', key: name, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers,
})

describe('terminal clipboard keys', () => {
  it('copies on Ctrl+C only with a selection, so Ctrl+C still interrupts', () => {
    expect(terminalClipboardKey(key('c', { ctrlKey: true }), true)).toBe('copy')
    expect(terminalClipboardKey(key('c', { ctrlKey: true }), false)).toBeUndefined()
    expect(terminalClipboardKey(key('C', { ctrlKey: true, shiftKey: true }), false)).toBe('copy')
  })

  it('pastes on Ctrl+V, Ctrl+Shift+V and Shift+Insert', () => {
    expect(terminalClipboardKey(key('v', { ctrlKey: true }), false)).toBe('paste')
    expect(terminalClipboardKey(key('V', { ctrlKey: true, shiftKey: true }), false)).toBe('paste')
    expect(terminalClipboardKey(key('Insert', { shiftKey: true }), false)).toBe('paste')
    expect(terminalClipboardKey(key('Insert', { ctrlKey: true }), true)).toBe('copy')
  })

  it('uses Cmd on macOS and leaves other keys and key-ups to the shell', () => {
    expect(terminalClipboardKey(key('c', { metaKey: true }), true)).toBe('copy')
    expect(terminalClipboardKey(key('v', { metaKey: true }), false)).toBe('paste')
    expect(terminalClipboardKey(key('d', { ctrlKey: true }), true)).toBeUndefined()
    expect(terminalClipboardKey(key('c', { ctrlKey: true, altKey: true }), true)).toBeUndefined()
    expect(terminalClipboardKey({ ...key('c', { ctrlKey: true }), type: 'keyup' }, true)).toBeUndefined()
  })
})
