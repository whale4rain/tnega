import { useEffect, useState } from 'react'

/** How long the sidebar and the Workbench take to fold in or out; `--duration-panel` in tokens.css. */
export const PANEL_MS = 220

/** Width at or below which the Workbench floats over the conversation instead of taking a column. */
export const WORKBENCH_OVERLAY_QUERY = '(max-width: 1100px)'

/** Whether a media query matches, kept up to date. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const media = matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

/**
 * True for one fold while a side panel opens or closes. The app frame only animates its columns
 * while this is set, so resizing the window or dragging the Workbench edge stays immediate.
 * The flag flips during render, in the same commit as the change it animates.
 */
export function usePanelMotion(key: string): boolean {
  const [last, setLast] = useState(key)
  const [moving, setMoving] = useState(false)
  if (last !== key) {
    setLast(key)
    setMoving(true)
  }
  useEffect(() => {
    if (!moving) return
    const timer = setTimeout(() => setMoving(false), PANEL_MS + 60)
    return () => clearTimeout(timer)
  }, [moving, key])
  return moving
}
