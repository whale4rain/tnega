/**
 * The terminal's palette, from the design guide's TUI section (Umbrella):
 * monochrome ink on the terminal's own ground. The terminal's foreground
 * is the ink, `dim` is the grey for metadata, and structure comes from
 * weight and space. There is no accent colour; whose turn it is lives in
 * the hand marks below. Colour is left only for errors (red), diff lines
 * (green / red) and warnings (yellow), and for the weather strip in
 * `weather.tsx`, which paints the sky in full colour. Named ANSI colours
 * follow the user's terminal theme, so light and dark terminals both read
 * well without detecting either.
 */
export const color = {
  success: 'green',
  warn: 'yellow',
  danger: 'red',
} as const

/**
 * The hand marks (design guide §3.9) as glyphs, one meaning each, always
 * beside a word: your turn, the agent working, waiting on someone else,
 * done, failed, nothing to do.
 */
export const mark = {
  you: '◉',
  working: '◐',
  waiting: '◌',
  done: '✓',
  failed: '✗',
  idle: '○',
} as const

export type Mark = keyof typeof mark

/** The working mark turning while it runs: its hatching sweeps round the circle. */
export const WORKING_FRAMES = ['◐', '◓', '◑', '◒'] as const

export const glyph = {
  prompt: '›',
  user: '›',
  bullet: '·',
  ok: mark.done,
  fail: mark.failed,
  rule: '─',
} as const

/** Ink's `color` prop, omitted when there is no colour to set. */
export function tint(value: string | undefined): { color?: string } {
  return value ? { color: value } : {}
}
