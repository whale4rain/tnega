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

type Rect = { x: number, y: number, width: number, height: number }

/** Frames the card must hold still before following stops. */
const SETTLE_FRAMES = 6

/**
 * Keeps the native view on the card. A panel that slides in or out moves the
 * card without resizing it, so no observer reports the change: each `follow()`
 * measures every animation frame and sends the rectangle whenever it changed,
 * until it has held still for a few frames.
 */
export function boundsFollower(options: {
  measure: () => Rect | null
  send: (rect: Rect | null) => void
  frame?: (callback: () => void) => number
  cancel?: (handle: number) => void
}): { follow: () => void, stop: () => void } {
  const frame = options.frame ?? requestAnimationFrame
  const cancel = options.cancel ?? cancelAnimationFrame
  let handle: number | undefined
  let last: string | undefined
  let still = 0
  const step = () => {
    const rect = options.measure()
    const key = JSON.stringify(rect)
    if (key !== last) {
      last = key
      still = 0
      options.send(rect)
    } else {
      still += 1
    }
    handle = still < SETTLE_FRAMES ? frame(step) : undefined
  }
  return {
    follow() {
      still = 0
      if (handle === undefined) handle = frame(step)
    },
    stop() {
      if (handle !== undefined) cancel(handle)
      handle = undefined
    },
  }
}

/** What to show in the address bar: nothing for a blank page. */
export function displayUrl(url: string): string {
  return url === 'about:blank' ? '' : url
}
