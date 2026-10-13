/**
 * The multi-line prompt box. Enter sends; Shift+Enter (where the terminal
 * reports it), Alt+Enter, Ctrl+J or a trailing `\` add a line. The real
 * terminal cursor sits on the caret so an IME composes Chinese in place.
 */
import { Box, Text, useCursor, useInput, usePaste, type DOMElement } from 'ink'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import * as edit from './editor.js'
import type { EditorState } from './editor.js'
import { glyph } from './theme.js'

export interface ComposerKeys {
  /** Up/Down/Tab/Enter/Esc go to the completion list instead of the text. */
  completing: boolean
  onCompletionMove: (delta: number) => void
  /** `submit` is true for Enter: a command that needs nothing more runs at once. */
  onCompletionAccept: (submit: boolean) => void
  onCompletionClose: () => void
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onHistory,
  active,
  placeholder,
  width,
  keys,
  origin,
}: {
  value: EditorState
  onChange: (next: EditorState) => void
  onSubmit: (text: string) => void
  /** Up on the first line or Down on the last walks sent prompts; returns the text to show. */
  onHistory: (direction: -1 | 1, current: string) => string | undefined
  active: boolean
  placeholder: string
  width: number
  keys: ComposerKeys
  /** The composer's top row within Ink's live output, for placing the terminal cursor. */
  origin: RefObject<DOMElement | null>
}) {
  const latest = useRef(value)
  latest.current = value
  const set = (next: EditorState) => {
    latest.current = next
    onChange(next)
  }

  usePaste(text => set(edit.insert(latest.current, text)), { isActive: active })

  useInput((input, key) => {
    const state = latest.current
    if (keys.completing) {
      if (key.upArrow) return keys.onCompletionMove(-1)
      if (key.downArrow) return keys.onCompletionMove(1)
      if (key.tab) return keys.onCompletionAccept(false)
      if (key.return && !key.shift && !key.meta) return keys.onCompletionAccept(true)
      if (key.escape) return keys.onCompletionClose()
    }
    if (key.return && (key.shift || key.meta)) return set(edit.insert(state, '\n'))
    if (input === '\n' || (key.ctrl && input === 'j')) return set(edit.insert(state, '\n'))
    if (key.return) {
      if (state.text.slice(0, state.caret).endsWith('\\')) {
        return set(edit.insert(edit.backspace(state), '\n'))
      }
      if (state.text.trim()) onSubmit(state.text)
      return
    }
    if (key.backspace) return set(key.meta ? edit.deleteWord(state) : edit.backspace(state))
    if (key.delete) return set(edit.deleteForward(state))
    if (key.leftArrow) return set(edit.left(state))
    if (key.rightArrow) return set(edit.right(state))
    if (key.home || (key.ctrl && input === 'a')) return set(edit.home(state))
    if (key.end || (key.ctrl && input === 'e')) return set(edit.end(state))
    if (key.upArrow) {
      if (edit.onFirstLine(state)) {
        const text = onHistory(-1, state.text)
        if (text !== undefined) return set({ text, caret: text.length })
      }
      return set(edit.up(state))
    }
    if (key.downArrow) {
      if (edit.onLastLine(state)) {
        const text = onHistory(1, state.text)
        if (text !== undefined) return set({ text, caret: text.length })
      }
      return set(edit.down(state))
    }
    if (key.ctrl && input === 'u') return set(edit.deleteToLineStart(state))
    if (key.ctrl && input === 'k') return set(edit.deleteToLineEnd(state))
    if (key.ctrl && input === 'w') return set(edit.deleteWord(state))
    if (key.ctrl || key.meta || key.escape || key.tab || key.pageUp || key.pageDown) return
    if (!input) return
    // Without bracketed paste, typed-ahead text and its Enter can arrive in one chunk.
    if (input.length > 1 && input.endsWith('\r') && !input.slice(0, -1).includes('\r')) {
      const next = edit.insert(state, input.slice(0, -1))
      set(next)
      if (next.text.trim()) onSubmit(next.text)
      return
    }
    set(edit.insert(state, input))
  }, { isActive: active })

  const inner = Math.max(10, width - 6)
  // The terminal cursor sits on the caret so an IME composes in place. Its
  // row comes from the last layout; a change re-renders once with the new spot.
  const { setCursorPosition } = useCursor()
  const [cursor, setCursor] = useState<{ x: number; y: number }>()
  const caret = edit.caretPosition(value)
  const rows = value.text.slice(0, value.caret).split('\n')
  const wrappedAbove = rows.slice(0, -1).reduce((sum, line) => sum + Math.max(1, Math.ceil(edit.lineWidth(line) / inner)), 0)
  const caretRow = wrappedAbove + Math.floor(caret.column / inner)
  const caretColumn = caret.column % inner
  useLayoutEffect(() => {
    const box = origin.current
    const next = active && box ? { x: 4 + caretColumn, y: absoluteTop(box) + 1 + caretRow } : undefined
    if (next?.x !== cursor?.x || next?.y !== cursor?.y) setCursor(next)
  })
  setCursorPosition(active ? cursor : undefined)

  const empty = !value.text
  const { before, at, after } = edit.splitAtCaret(value)
  return (
    <Box borderStyle="round" borderDimColor paddingX={1} width={width} flexDirection="row">
      <Box width={2} flexShrink={0}><Text dimColor={!active}>{glyph.prompt}</Text></Box>
      <Box flexGrow={1} width={inner}>
        {empty
          ? <Text dimColor>{active ? <Text inverse> </Text> : null}{placeholder}</Text>
          : (
              <Text>
                {before}
                {active ? <Text inverse>{at === '\n' || !at ? ' ' : at}</Text> : at === '\n' ? '' : at}
                {at === '\n' ? '\n' : ''}
                {after}
              </Text>
            )}
      </Box>
    </Box>
  )
}

/** Rows from the top of Ink's live output to `node`. */
function absoluteTop(node: DOMElement): number {
  let top = 0
  let current: DOMElement | undefined = node
  while (current) {
    top += current.yogaNode?.getComputedTop() ?? 0
    current = current.parentNode
  }
  return top
}
