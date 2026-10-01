/**
 * The Windows title bar overlay (minimise / maximise / close) is drawn by the
 * native frame, so the renderer tells the main process which colours sit
 * behind it whenever the theme or layout changes. Only plain hex colours are
 * accepted from the renderer.
 */
export interface TitleBarColors {
  background: string
  foreground: string
}

/** Height of the native control strip, shared with the renderer layout. */
export const TITLE_BAR_HEIGHT = 32

export const DEFAULT_TITLE_BAR_COLORS: Readonly<Record<'light' | 'dark', TitleBarColors>> = {
  light: { background: '#f6f5f1', foreground: '#57544d' },
  dark: { background: '#141615', foreground: '#aaa79f' },
}

const HEX = /^#[0-9a-f]{6}$/i

export function parseTitleBarColors(value: unknown): TitleBarColors | undefined {
  if (!value || typeof value !== 'object' || !('background' in value) || !('foreground' in value)) return undefined
  const { background, foreground } = value
  if (typeof background !== 'string' || typeof foreground !== 'string') return undefined
  if (!HEX.test(background) || !HEX.test(foreground)) return undefined
  return { background: background.toLowerCase(), foreground: foreground.toLowerCase() }
}
