/**
 * The terminal's palette, from the design guide's TUI section: the
 * terminal's own foreground and background carry everything, `dim` marks
 * metadata, and colour appears only for state (green done, yellow waiting,
 * red failed). Named ANSI colours follow the user's terminal theme, so light
 * and dark terminals both read well without detecting either.
 */
import type { Weather } from '@tnega/client'

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

/** The colour a weather's mark takes; undefined keeps the terminal's foreground. */
export function weatherColor(weather: Weather): string | undefined {
  switch (weather) {
    case 'snow':
    case 'fog':
    case 'sleet':
      return color.warn
    case 'storm':
      return color.danger
    case 'rainbow':
      return color.success
    default:
      return undefined
  }
}

/** Weathers drawn with the spinner: something is happening right now. */
export function weatherSpins(weather: Weather): boolean {
  return weather === 'cloudy' || weather === 'drizzle' || weather === 'rain' || weather === 'sleet' || weather === 'sprite'
}

/** A still mark for the settled weathers. */
export function weatherMark(weather: Weather): string {
  switch (weather) {
    case 'snow':
      return '❄'
    case 'storm':
      return glyph.fail
    case 'rainbow':
      return glyph.ok
    case 'fog':
      return '≈'
    default:
      return glyph.pending
  }
}

/** Ink's `color` prop, omitted when there is no colour to set. */
export function tint(value: string | undefined): { color?: string } {
  return value ? { color: value } : {}
}
