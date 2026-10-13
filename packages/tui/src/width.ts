import stringWidthImpl from 'string-width'

/** Terminal cells a string takes: CJK and most emoji are two, ANSI codes none. */
export function stringWidth(text: string): number {
  return stringWidthImpl(text)
}

/** Cut `text` to at most `width` cells, ending in `…` when anything was dropped. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  if (stringWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const cells = stringWidth(char)
    if (used + cells > width - 1) break
    out += char
    used += cells
  }
  return `${out}…`
}

/** Pad `text` with spaces to `width` cells. */
export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)))
}
