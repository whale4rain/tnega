/**
 * The terminal's palette, from the design guide's TUI section: the
 * terminal's own foreground and background carry everything, `dim` marks
 * metadata, and colour appears only for state (green done, yellow waiting,
 * red failed). The one exception is the weather strip in `weather.tsx`,
 * which paints the sky in full colour. Named ANSI colours follow the user's
 * terminal theme, so light and dark terminals both read well without
 * detecting either.
 */
export const color = {
  success: 'green',
  warn: 'yellow',
  danger: 'red',
} as const

/** Braille spinner frames: one cell wide everywhere, including CJK locales. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export const glyph = {
  prompt: '›',
  user: '›',
  bullet: '·',
  ok: '✓',
  fail: '✕',
  pending: '○',
  done: '●',
  rule: '─',
} as const

/** Ink's `color` prop, omitted when there is no colour to set. */
export function tint(value: string | undefined): { color?: string } {
  return value ? { color: value } : {}
}
