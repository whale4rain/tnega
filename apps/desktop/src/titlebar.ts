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

/**
 * macOS draws its traffic lights itself, at the top-left: centred in the
 * 32px bar, inside the 72px the renderer keeps clear (`.window-controls-header-start`).
 */
export const TRAFFIC_LIGHTS = { x: 14, y: 10 } as const

export const DEFAULT_TITLE_BAR_COLORS: Readonly<Record<'light' | 'dark', TitleBarColors>> = {
  light: { background: '#f7f7f6', foreground: '#3f3f3e' },
  dark: { background: '#191919', foreground: '#bdbdbb' },
}

const HEX = /^#[0-9a-f]{6}$/i

export function parseTitleBarColors(value: unknown): TitleBarColors | undefined {
  if (!value || typeof value !== 'object' || !('background' in value) || !('foreground' in value)) return undefined
  const { background, foreground } = value
  if (typeof background !== 'string' || typeof foreground !== 'string') return undefined
  if (!HEX.test(background) || !HEX.test(foreground)) return undefined
  return { background: background.toLowerCase(), foreground: foreground.toLowerCase() }
}
