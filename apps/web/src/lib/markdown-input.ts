/**
 * Markdown helpers for the message box: list editing as you type and the
 * pieces the highlight layer under the textarea paints.
 */

/** A text edit: the whole new value and where the caret goes. */
export interface InputEdit {
  text: string
  caret: number
}

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(\s+)(\[[ xX]\]\s+)?/

interface ListItem {
  indent: string
  /** The marker for the next item: `- `, `2. `, `- [ ] `. */
  next: string
  /** Everything before the item's text, e.g. `  1. `. */
  prefix: string
}

function listItem(line: string): ListItem | undefined {
  const match = LIST_ITEM.exec(line)
  if (!match) return undefined
  const [prefix, indent = '', bullet, number, delimiter, gap = ' ', task] = match
  const marker = bullet ?? `${Number(number) + 1}${delimiter}`
  return { indent, prefix, next: `${indent}${marker}${gap}${task ? '[ ] ' : ''}` }
}

function lineBounds(text: string, at: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', at - 1) + 1
  const newline = text.indexOf('\n', at)
  return { start, end: newline === -1 ? text.length : newline }
}

/**
 * A new line inside a list carries the list on: `1. a` gives `2. `, `- a`
 * gives `- `. On an item with no text yet it ends the list instead, leaving
 * an empty line. Undefined when the caret is not on a list item, or there is
 * a selection, so the box inserts a plain newline.
 */
export function continueList(text: string, start: number, end: number = start): InputEdit | undefined {
  if (start !== end) return undefined
  const line = lineBounds(text, start)
  const item = listItem(text.slice(line.start, line.end))
  if (!item || start < line.start + item.prefix.length) return undefined
  if (!text.slice(line.start + item.prefix.length, line.end).trim()) {
    return { text: text.slice(0, line.start) + text.slice(line.end), caret: line.start }
  }
  const insert = `\n${item.next}`
  return { text: text.slice(0, start) + insert + text.slice(start), caret: start + insert.length }
}

/**
 * Tab on a list item nests it one level (two spaces); Shift+Tab lifts it.
 * Undefined when the caret's line is not a list item, so Tab moves focus as
 * usual.
 */
export function indentList(text: string, start: number, end: number, outdent: boolean): InputEdit | undefined {
  const line = lineBounds(text, start)
  const last = lineBounds(text, end)
  const lines = text.slice(line.start, last.end).split('\n')
  if (!lines.every(each => !each.trim() || listItem(each))) return undefined
  if (!lines.some(each => listItem(each))) return undefined
  let shift = 0
  const changed = lines.map((each, index) => {
    if (!listItem(each)) return each
    const removed = outdent ? Math.min(2, each.length - each.trimStart().length) : -2
    if (index === 0) shift = -removed
    // A nested numbered list starts again at 1.
    return outdent ? each.slice(removed) : `  ${each.replace(/^(\s*)\d+([.)])/, '$11$2')}`
  })
  const next = text.slice(0, line.start) + changed.join('\n') + text.slice(last.end)
  return { text: next, caret: Math.max(line.start, start + shift) }
}

/** One painted piece of the highlight layer. `kind` undefined is plain text. */
export interface MarkdownToken {
  text: string
  kind?: 'marker' | 'heading' | 'quote' | 'code' | 'fence' | 'syntax' | 'strong' | 'emphasis'
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|(?<!\w)__[^_\n]+__(?!\w))|(\*[^*\s][^*\n]*\*|(?<!\w)_[^_\s][^_\n]*_(?!\w))/g

function inline(text: string, tokens: MarkdownToken[]) {
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index
    if (at > last) tokens.push({ text: text.slice(last, at) })
    const [whole, code, strong] = match
    if (code) tokens.push({ text: whole, kind: 'code' })
    else {
      const width = strong ? 2 : 1
      tokens.push({ text: whole.slice(0, width), kind: 'syntax' })
      tokens.push({ text: whole.slice(width, -width), kind: strong ? 'strong' : 'emphasis' })
      tokens.push({ text: whole.slice(-width), kind: 'syntax' })
    }
    last = at + whole.length
  }
  if (last < text.length) tokens.push({ text: text.slice(last) })
}

/**
 * Splits the box's text into the pieces the highlight layer paints. Joined
 * back together the pieces are exactly `text`, so the layer lines up with
 * the textarea character for character; only colours differ, never widths.
 */
export function markdownTokens(text: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = []
  let fenced = false
  text.split('\n').forEach((line, index) => {
    if (index > 0) tokens.push({ text: '\n' })
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      tokens.push({ text: line, kind: 'fence' })
      return
    }
    if (fenced) {
      if (line) tokens.push({ text: line, kind: 'code' })
      return
    }
    const heading = /^#{1,6}\s/.exec(line)
    if (heading) {
      tokens.push({ text: heading[0], kind: 'syntax' })
      tokens.push({ text: line.slice(heading[0].length), kind: 'heading' })
      return
    }
    const quote = /^\s*>\s?/.exec(line)
    if (quote) {
      tokens.push({ text: quote[0], kind: 'syntax' })
      tokens.push({ text: line.slice(quote[0].length), kind: 'quote' })
      return
    }
    const item = LIST_ITEM.exec(line)
    let rest = line
    if (item) {
      const indent = item[1] ?? ''
      if (indent) tokens.push({ text: indent })
      tokens.push({ text: item[0].slice(indent.length), kind: 'marker' })
      rest = line.slice(item[0].length)
    }
    inline(rest, tokens)
  })
  return tokens.filter(token => token.text)
}
