import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

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

type Rgba = [number, number, number, number]

/** Computed colours as channels: `rgb()` / `rgba()` from plain colours, `color(srgb …)` from `color-mix()`. */
function parseColor(color: string): Rgba | undefined {
  const value = color.trim()
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])]
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value)
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])]
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  return hex ? [parseInt(hex[1] ?? '0', 16), parseInt(hex[2] ?? '0', 16), parseInt(hex[3] ?? '0', 16), 1] : undefined
}

function toHex([red, green, blue]: Rgba): string {
  return `#${[red, green, blue].map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

/** `rgb(1, 2, 3)` / `rgba(1, 2, 3, 0.5)` → `#010203`; fully transparent colours give `undefined`. */
export function cssColorToHex(color: string): string | undefined {
  const parsed = parseColor(color)
  return parsed && parsed[3] > 0 ? toHex(parsed) : undefined
}

/**
 * The colour seen at `element`: the first opaque background at or above it, with any translucent
 * layers in between (a dialog's scrim) mixed over it, so the native controls dim along with the page.
 */
export function backgroundBehind(element: Element | null, fallback: string): string {
  const layers: Rgba[] = []
  let base: Rgba | undefined
  for (let node = element; node && !base; node = node.parentElement) {
    const color = parseColor(getComputedStyle(node).backgroundColor)
    if (!color || color[3] === 0) continue
    if (color[3] >= 1) base = color
    else layers.push(color)
  }
  if (!base && !layers.length) return fallback
  base ??= parseColor(fallback) ?? [255, 255, 255, 1]
  const mixed = layers.reduceRight<Rgba>((under, [red, green, blue, alpha]) => [
    red * alpha + under[0] * (1 - alpha), green * alpha + under[1] * (1 - alpha), blue * alpha + under[2] * (1 - alpha), 1,
  ], base)
  return toHex(mixed)
}

/** Only the bar touching the native controls needs horizontal clearance. */
export function markWindowControls(root: ParentNode, width: number): void {
  for (const header of root.querySelectorAll('.conv-header, .wb-header, .project-side .side-tabs, .project-side .side-header')) {
    const rect = header.getBoundingClientRect()
    const edge = header.matches('.wb-header') ? header.closest('.workbench')?.getBoundingClientRect() ?? rect : rect
    header.classList.toggle('window-controls-header', rect.width > 0 && rect.top < 32 && rect.bottom > 0 && edge.right >= width - 1)
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
        const fallback = cssColorToHex(styles.getPropertyValue('--bg')) ?? '#f4f6f8'
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
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] })
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
