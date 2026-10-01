/**
 * Bridge to the desktop app's agent browser (see apps/desktop/src/browser.ts).
 * Absent in a plain web page, where the agent's browser is a separate window.
 */

export interface DesktopBrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface DesktopBrowserBridge {
  setBounds(rect: { x: number, y: number, width: number, height: number } | null): void
  navigate(url: string): void
  command(command: 'back' | 'forward' | 'reload' | 'stop' | 'state'): void
  onState(listener: (state: DesktopBrowserState) => void): () => void
  onReveal(listener: () => void): () => void
}

export function desktopBrowser(): DesktopBrowserBridge | undefined {
  const desktop: unknown = Reflect.get(globalThis, 'tnegaDesktop')
  if (!desktop || typeof desktop !== 'object') return undefined
  const browser: unknown = Reflect.get(desktop, 'browser')
  return browser && typeof browser === 'object' && typeof Reflect.get(browser, 'setBounds') === 'function'
    ? browser as DesktopBrowserBridge
    : undefined
}

/**
 * The native view paints above every HTML element, so it must step aside
 * while something floats over the panel: dialogs, menus, the image viewer.
 */
export const OVERLAY_SELECTOR = '.dialog-scrim, .image-viewer, .menu-popover, .slash-menu'

/** Panel rectangle in window coordinates, or null when it should be hidden. */
export function viewportRect(element: Element | null, covered: boolean): { x: number, y: number, width: number, height: number } | null {
  if (!element || covered) return null
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

/** What to show in the address bar: nothing for a blank page. */
export function displayUrl(url: string): string {
  return url === 'about:blank' ? '' : url
}
