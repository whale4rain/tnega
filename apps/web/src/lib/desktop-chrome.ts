import { useEffect } from 'react'

/**
 * In the desktop app the native minimise / maximise / close buttons float over
 * the top-right corner. This marks the page so CSS can keep content clear of
 * them, and recolours them to match whatever the page draws underneath.
 */

interface DesktopBridge {
  setTitleBarColors?: (colors: { background: string, foreground: string }) => void
}

function bridge(): DesktopBridge | undefined {
  const candidate: unknown = Reflect.get(globalThis, 'tnegaDesktop')
  return candidate && typeof candidate === 'object' ? candidate : undefined
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

/** Only the bar touching the native controls needs horizontal clearance. */
export function markWindowControls(root: ParentNode, width: number): void {
  for (const header of root.querySelectorAll('.conv-header, .drawer-header, .project-side .side-tabs, .project-side .side-header')) {
    const rect = header.getBoundingClientRect()
    header.classList.toggle('window-controls-header', rect.width > 0 && rect.top < 32 && rect.bottom > 0 && rect.right >= width - 1)
  }
}

export function useDesktopChrome(layoutKey: string): void {
  useEffect(() => {
    const desktop = bridge()
    if (!desktop?.setTitleBarColors) return
    const root = document.documentElement
    root.classList.add('desktop-chrome')
    let last = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    // A timer rather than an animation frame: frames stop while the window is hidden or minimised,
    // and reading computed styles already brings layout up to date.
    const sync = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        markWindowControls(document, innerWidth)
        const styles = getComputedStyle(root)
        const fallback = cssColorToHex(styles.getPropertyValue('--bg')) ?? '#f6f5f1'
        const background = backgroundBehind(document.elementFromPoint(innerWidth - 4, 4), fallback)
        const foreground = cssColorToHex(styles.getPropertyValue('--text-2')) ?? '#57544d'
        const key = `${background}/${foreground}`
        if (key === last) return
        last = key
        desktop.setTitleBarColors?.({ background, foreground })
      }, 0)
    }
    sync()
    const themeObserver = new MutationObserver(sync)
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    // Workspace loading and opening drawers can mount a header after the effect.
    const layoutObserver = new MutationObserver(sync)
    layoutObserver.observe(document.body, { childList: true, subtree: true })
    addEventListener('resize', sync)
    // Panels inside a view (project side panel, tabs) change the corner without changing `layoutKey`.
    addEventListener('click', sync, { passive: true })
    return () => {
      clearTimeout(timer)
      themeObserver.disconnect()
      layoutObserver.disconnect()
      removeEventListener('resize', sync)
      removeEventListener('click', sync)
      root.classList.remove('desktop-chrome')
      document.querySelectorAll('.window-controls-header').forEach(header => header.classList.remove('window-controls-header'))
    }
  }, [layoutKey])
}
