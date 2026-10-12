/**
 * The composer's text model: a string and a caret, edited by grapheme so a
 * Chinese character, an emoji or a combining sequence moves and deletes as
 * one unit. Pure functions, so the behaviour is testable without a terminal.
 */
import { stringWidth } from './width.js'

export interface EditorState {
  text: string
  /** Caret as a UTF-16 offset into `text`, always on a grapheme boundary. */
  caret: number
}

export const EMPTY: EditorState = { text: '', caret: 0 }

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), segment => segment.segment)
}

export function insert(state: EditorState, value: string): EditorState {
  // Terminals send CR for Enter inside pastes; keep one newline style.
  const clean = value.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
  return {
    text: state.text.slice(0, state.caret) + clean + state.text.slice(state.caret),
    caret: state.caret + clean.length,
  }
}

function previousBoundary(text: string, caret: number): number {
  if (caret <= 0) return 0
  const before = graphemes(text.slice(0, caret))
  return caret - (before.at(-1)?.length ?? 0)
}

function nextBoundary(text: string, caret: number): number {
  if (caret >= text.length) return text.length
  const after = graphemes(text.slice(caret))
  return caret + (after[0]?.length ?? 0)
}

export function backspace(state: EditorState): EditorState {
  if (state.caret === 0) return state
  const start = previousBoundary(state.text, state.caret)
  return { text: state.text.slice(0, start) + state.text.slice(state.caret), caret: start }
}

export function deleteForward(state: EditorState): EditorState {
  if (state.caret >= state.text.length) return state
  const end = nextBoundary(state.text, state.caret)
  return { text: state.text.slice(0, state.caret) + state.text.slice(end), caret: state.caret }
}

export function left(state: EditorState): EditorState {
  return { ...state, caret: previousBoundary(state.text, state.caret) }
}

export function right(state: EditorState): EditorState {
  return { ...state, caret: nextBoundary(state.text, state.caret) }
}

function lineStart(text: string, caret: number): number {
  return text.lastIndexOf('\n', caret - 1) + 1
}

function lineEnd(text: string, caret: number): number {
  const end = text.indexOf('\n', caret)
  return end < 0 ? text.length : end
}

export function home(state: EditorState): EditorState {
  return { ...state, caret: lineStart(state.text, state.caret) }
}

export function end(state: EditorState): EditorState {
  return { ...state, caret: lineEnd(state.text, state.caret) }
}

/** Delete from the caret back to the start of its line (Ctrl+U). */
export function deleteToLineStart(state: EditorState): EditorState {
  const start = lineStart(state.text, state.caret)
  const from = start === state.caret && start > 0 ? start - 1 : start
  return { text: state.text.slice(0, from) + state.text.slice(state.caret), caret: from }
}

/** Delete from the caret to the end of its line (Ctrl+K). */
export function deleteToLineEnd(state: EditorState): EditorState {
  const stop = lineEnd(state.text, state.caret)
  const to = stop === state.caret && stop < state.text.length ? stop + 1 : stop
  return { text: state.text.slice(0, state.caret) + state.text.slice(to), caret: state.caret }
}

/** Delete the word before the caret (Ctrl+W, Alt+Backspace). */
export function deleteWord(state: EditorState): EditorState {
  const before = state.text.slice(0, state.caret)
  // The word and any spaces after it, as a shell's Ctrl+W.
  const length = /\S*\s*$/u.exec(before)?.[0].length ?? 0
  const start = Math.max(0, state.caret - (length || 1))
  return { text: state.text.slice(0, start) + state.text.slice(state.caret), caret: start }
}

/** Display column of the caret within its line, in terminal cells. */
function caretColumn(text: string, caret: number): number {
  return stringWidth(text.slice(lineStart(text, caret), caret))
}

/** Offset in the line starting at `start` closest to display column `column`. */
function offsetAtColumn(text: string, start: number, column: number): number {
  const stop = lineEnd(text, start)
  let offset = start
  let width = 0
  for (const part of graphemes(text.slice(start, stop))) {
    const next = width + stringWidth(part)
    if (next > column) break
    width = next
    offset += part.length
  }
  return offset
}

/** Whether the caret is on the first line, where Up leaves the text for history. */
export function onFirstLine(state: EditorState): boolean {
  return !state.text.slice(0, state.caret).includes('\n')
}

export function onLastLine(state: EditorState): boolean {
  return !state.text.slice(state.caret).includes('\n')
}

export function up(state: EditorState): EditorState {
  if (onFirstLine(state)) return { ...state, caret: 0 }
  const column = caretColumn(state.text, state.caret)
  const start = lineStart(state.text, state.caret)
  return { ...state, caret: offsetAtColumn(state.text, lineStart(state.text, start - 1), column) }
}

export function down(state: EditorState): EditorState {
  if (onLastLine(state)) return { ...state, caret: state.text.length }
  const column = caretColumn(state.text, state.caret)
  return { ...state, caret: offsetAtColumn(state.text, lineEnd(state.text, state.caret) + 1, column) }
}

/** The caret's row and display column, for drawing it and placing the IME window. */
export function caretPosition(state: EditorState): { row: number; column: number } {
  const before = state.text.slice(0, state.caret)
  const row = before.split('\n').length - 1
  return { row, column: caretColumn(state.text, state.caret) }
}

/** Split `text` at the caret into what is before it, the grapheme under it, and the rest. */
export function splitAtCaret(state: EditorState): { before: string; at: string; after: string } {
  const next = nextBoundary(state.text, state.caret)
  return {
    before: state.text.slice(0, state.caret),
    at: state.text.slice(state.caret, next),
    after: state.text.slice(next),
  }
}

/** Sent prompts, newest last; Up and Down walk them when the caret is at the edge. */
export class History {
  private readonly items: string[] = []
  private index = 0
  private stash = ''

  push(text: string): void {
    if (text.trim() && this.items.at(-1) !== text) this.items.push(text)
    this.index = this.items.length
    this.stash = ''
  }

  previous(current: string): string | undefined {
    if (this.index === 0) return undefined
    if (this.index === this.items.length) this.stash = current
    this.index -= 1
    return this.items[this.index]
  }

  next(): string | undefined {
    if (this.index >= this.items.length) return undefined
    this.index += 1
    return this.index === this.items.length ? this.stash : this.items[this.index]
  }
}

/** Terminal cells a line takes. */
export function lineWidth(line: string): number {
  return stringWidth(line)
}
