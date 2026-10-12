import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * In the desktop app the native minimise / maximise / close buttons float over
 * the top-right corner (the traffic lights over the top-left on macOS). This
 * marks the page so CSS can keep content clear of them, and recolours them to
 * match whatever the page draws underneath.
 */

interface DesktopBridge {
  setTitleBarColors?: (colors: { background: string, foreground: string }) => void
  platform?: string
}

function bridge(): DesktopBridge | undefined {
  const candidate: unknown = Reflect.get(globalThis, 'tnegaDesktop')
  return candidate && typeof candidate === 'object' ? candidate : undefined
}

/** True inside the desktop app, where native window controls float over the top-right corner. */
export function isDesktopChrome(): boolean {
  return Boolean(bridge()?.setTitleBarColors)
}

/**
 * A header's actions, rendered in place or, when the Workbench is open in the
 * desktop app, in its title-bar row beside the window controls.
 */
export function inTitleBar(slot: HTMLElement | null | undefined, actions: ReactNode): ReactNode {
  return slot ? createPortal(actions, slot) : actions
}

/** `rgb(1, 2, 3)` / `rgba(1, 2, 3, 0.5)` → `#010203`; fully transparent colours give `undefined`. */
export function cssColorToHex(color: string): string | undefined {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(color.trim())
  if (!match) return /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim().toLowerCase() : undefined
  if (match[4] !== undefined && Number(match[4]) === 0) return undefined
  return `#${[match[1], match[2], match[3]].map(channel => Number(channel).toString(16).padStart(2, '0')).join('')}`
}

/** The first opaque background at or above `element`. */
export function backgroundBehind(element: Element | null, fallback: string): string {
  for (let node = element; node; node = node.parentElement) {
    const hex = cssColorToHex(getComputedStyle(node).backgroundColor)
    if (hex) return hex
  }
  return fallback
}

/** How far the macOS traffic lights reach from the window's left edge, in CSS pixels. */
const TRAFFIC_LIGHTS_WIDTH = 72

/** Which top corner the native window controls occupy. */
export function windowControlsSide(platform = bridge()?.platform): 'left' | 'right' {
  return platform === 'darwin' ? 'left' : 'right'
}

const HEADERS = '.sidebar-top, .conv-header, .wb-header, .project-side .side-tabs, .project-side .side-header'

/** Only the bar touching the native controls needs horizontal clearance. */
export function markWindowControls(root: ParentNode, width: number, side: 'left' | 'right' = 'right'): void {
  for (const header of root.querySelectorAll(HEADERS)) {
    const rect = header.getBoundingClientRect()
    const edge = header.matches('.wb-header') ? header.closest('.workbench')?.getBoundingClientRect() ?? rect : rect
    const atTop = rect.width > 0 && rect.top < 32 && rect.bottom > 0
    header.classList.toggle('window-controls-header', side === 'right' && atTop && edge.right >= width - 1)
    // The sidebar card is inset from the window edge, so on macOS any top bar that
    // starts under the traffic lights needs clearance, not only one at x = 0.
    header.classList.toggle('window-controls-header-start', side === 'left' && atTop && edge.left < TRAFFIC_LIGHTS_WIDTH)
  }
}

export function useDesktopChrome(layoutKey: string): void {
  useEffect(() => {
    const desktop = bridge()
    if (!desktop?.setTitleBarColors) return
    const root = document.documentElement
    const side = windowControlsSide(desktop.platform)
    root.classList.add('desktop-chrome')
    root.classList.toggle('window-controls-left', side === 'left')
    let last = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    // A timer rather than an animation frame: frames stop while the window is hidden or minimised,
    // and reading computed styles already brings layout up to date.
    const sync = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        markWindowControls(document, innerWidth, side)
        for (const header of document.querySelectorAll(HEADERS)) sizeObserver?.observe(header)
        // macOS draws its traffic lights itself; there is nothing to recolour.
        if (side === 'left') return
        const styles = getComputedStyle(root)
        const fallback = cssColorToHex(styles.getPropertyValue('--bg')) ?? '#f4f6f8'
        const background = backgroundBehind(document.elementFromPoint(innerWidth - 4, 4), fallback)
        const foreground = cssColorToHex(styles.getPropertyValue('--text-2')) ?? '#57544d'
        const key = `${background}/${foreground}`
        if (key === last) return
        last = key
        desktop.setTitleBarColors?.({ background, foreground })
      }, 0)
    }
    // Panels settle their size after mounting (transitions, late styles) without any
    // DOM change or window resize; macOS starts with nothing else to trigger a sync.
    const sizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : undefined
    sync()
    const themeObserver = new MutationObserver(sync)
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] })
    // Workspace loading and opening drawers can mount a header after the effect.
    const layoutObserver = new MutationObserver(sync)
    layoutObserver.observe(document.body, { childList: true, subtree: true })
    addEventListener('resize', sync)
    // Panels inside a view (project side panel, tabs) change the corner without changing `layoutKey`.
    addEventListener('click', sync, { passive: true })
    return () => {
      clearTimeout(timer)
      sizeObserver?.disconnect()
      themeObserver.disconnect()
      layoutObserver.disconnect()
      removeEventListener('resize', sync)
      removeEventListener('click', sync)
      root.classList.remove('desktop-chrome', 'window-controls-left')
      document.querySelectorAll('.window-controls-header, .window-controls-header-start').forEach(header => header.classList.remove('window-controls-header', 'window-controls-header-start'))
    }
  }, [layoutKey])
}
