import { useEffect, useRef, type ReactNode } from 'react'
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
 * A `::before` that covers its element paints a surface of its own: with Glass everywhere the
 * conversation header and the Workbench title strip keep their glass there, not on the element.
 */
function coveringBefore(node: Element): Rgba | undefined {
  const style = getComputedStyle(node, '::before')
  if (style.content === 'none' || style.content === 'normal' || style.content === '' || style.position !== 'absolute') return undefined
  if ([style.top, style.right, style.bottom, style.left].some(edge => edge !== '0px')) return undefined
  return parseColor(style.backgroundColor)
}

/**
 * The colour seen at `element`: the first opaque background at or above it, with any translucent
 * layers in between (a glass header, a dialog's scrim) mixed over it, so the native controls match
 * the bar they sit in and dim along with the page.
 */
export function backgroundBehind(element: Element | null, fallback: string): string {
  const layers: Rgba[] = []
  let base: Rgba | undefined
  for (let node = element; node && !base; node = node.parentElement) {
    for (const color of [parseColor(getComputedStyle(node).backgroundColor), coveringBefore(node)]) {
      if (!color || color[3] === 0 || base) continue
      if (color[3] >= 1) base = color
      else layers.push(color)
    }
  }
  if (!base && !layers.length) return fallback
  base ??= parseColor(fallback) ?? [255, 255, 255, 1]
  const mixed = layers.reduceRight<Rgba>((under, [red, green, blue, alpha]) => [
    red * alpha + under[0] * (1 - alpha), green * alpha + under[1] * (1 - alpha), blue * alpha + under[2] * (1 - alpha), 1,
  ], base)
  return toHex(mixed)
}

/** How far the macOS traffic lights reach from the window's left edge, in CSS pixels. */
const TRAFFIC_LIGHTS_WIDTH = 72

/** Which top corner the native window controls occupy. */
export function windowControlsSide(platform = bridge()?.platform): 'left' | 'right' {
  return platform === 'darwin' ? 'left' : 'right'
}

const HEADERS = '.sidebar-top, .conv-header, .wb-header, .project-side .side-tabs, .project-side .side-header'

/** How far a bar ends short of the window edge, for the CSS that keeps only the room the controls still take. */
function markGap(header: Element, gap: number): void {
  const value = `${gap}px`
  const style = (header as HTMLElement).style
  if (style.getPropertyValue('--window-controls-gap') !== value) style.setProperty('--window-controls-gap', value)
}

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
    // The conversation header keeps only the room the controls still take from its own end (CSS), so
    // its clearance follows a panel folding in beside it instead of snapping by the controls' width a
    // frame into the fold, which shifted the title area mid-slide.
    markGap(header, atTop ? Math.max(0, Math.round(width - edge.right)) : 0)
  }
}

/** The Workbench's title strip, while its open panel holds the corner beside the window controls. */
function titleStrip(): Element | undefined {
  if (!document.querySelector('.app.workbench-open')) return undefined
  // A floating panel (a narrow window) hides the strip: the conversation header keeps the corner.
  const strip = document.querySelector('.wb-titlebar')
  return strip && strip.getClientRects().length > 0 ? strip : undefined
}

/** The bar running to the top-right corner of the view: the conversation's or a project's header. */
function cornerHeader(): Element | undefined {
  let bar: Element | undefined
  let right = -Infinity
  for (const header of document.querySelectorAll(HEADERS)) {
    // The Workbench's own rows sit behind a panel that may be folded off screen.
    if (header.closest('.workbench')) continue
    const rect = header.getBoundingClientRect()
    if (rect.width <= 0 || rect.top >= 32 || rect.bottom <= 0) continue
    if (rect.right > right) {
      right = rect.right
      bar = header
    }
  }
  return bar
}

/**
 * What the native controls sit on, and so the colour they take: the scrim of a dialog or a menu
 * covering the corner (they dim the controls with the page), the Workbench's title strip while its
 * panel holds the corner, else the view's header. The point itself often holds neither — it lands in
 * the gap the panel leaves at the window edge, on its drag strip, or on the frame once the folded
 * panel is inert — so a hit that is not a bar resolves to the bar the corner belongs to. That keeps
 * the controls one colour for the whole fold instead of flashing the page colour and back.
 */
function cornerSurface(hit: Element | null): Element | undefined {
  const overlay = hit?.closest('.dialog-scrim, .image-viewer, .menu-popover')
  if (overlay) return overlay
  return hit?.closest('.wb-titlebar, .conv-header') ?? titleStrip() ?? cornerHeader() ?? hit ?? undefined
}

/**
 * Marks the page for the desktop title bar and keeps it in step with the layout. The setup runs
 * once: a layout change (`layoutKey`) only asks for a fresh sync. Tearing the setup down on every
 * change dropped the `desktop-chrome` class and the headers' clearance for a few frames, so each
 * panel toggle made the header and the title-bar row jump sideways and back.
 */
export function useDesktopChrome(layoutKey: string): void {
  const resync = useRef<(() => void) | undefined>(undefined)
  useEffect(() => {
    resync.current?.()
  }, [layoutKey])
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
        const background = backgroundBehind(cornerSurface(document.elementFromPoint(innerWidth - 4, 4)) ?? null, fallback)
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
    resync.current = sync
    const themeObserver = new MutationObserver(sync)
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-palette', 'data-glass'] })
    // Workspace loading and opening drawers can mount a header after the effect.
    const layoutObserver = new MutationObserver(sync)
    layoutObserver.observe(document.body, { childList: true, subtree: true })
    addEventListener('resize', sync)
    // Panels inside a view (project side panel, tabs) change the corner without changing `layoutKey`.
    addEventListener('click', sync, { passive: true })
    return () => {
      resync.current = undefined
      clearTimeout(timer)
      sizeObserver?.disconnect()
      themeObserver.disconnect()
      layoutObserver.disconnect()
      removeEventListener('resize', sync)
      removeEventListener('click', sync)
      root.classList.remove('desktop-chrome', 'window-controls-left')
      document.querySelectorAll('.window-controls-header, .window-controls-header-start').forEach(header => header.classList.remove('window-controls-header', 'window-controls-header-start'))
    }
  }, [])
}
