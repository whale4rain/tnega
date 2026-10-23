import { useCallback, useEffect, useRef, useState } from 'react'
import { applyFade, canMoveViewport, followsEnd, metricsOf, scrollsViewport, takesKeys, type ScrollEdges } from './scroll'
import { workbenchApi } from './workbench-api'

export function useStoredState<T extends string>(key: string, fallback: T, allowed?: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored !== null && (!allowed || (allowed as readonly string[]).includes(stored))) return stored as T
    } catch {
      // Storage can be unavailable (private mode, sandboxed webviews).
    }
    return fallback
  })
  const update = useCallback((next: T) => {
    setValue(next)
    try {
      localStorage.setItem(key, next)
    } catch {
      // See above.
    }
  }, [key])
  return [value, update]
}

export type ThemePreference = 'system' | 'light' | 'dark'

export function useTheme(): [ThemePreference, (value: ThemePreference) => void] {
  const [preference, setPreference] = useStoredState<ThemePreference>('tnega.theme', 'system', ['system', 'light', 'dark'])
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = preference === 'dark' || (preference === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [preference])
  return [preference, setPreference]
}

/** Close a popover when clicking outside `ref` or pressing Escape. */
export function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, onDismiss: () => void): void {
  const latest = useRef(onDismiss)
  latest.current = onDismiss
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) latest.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        latest.current()
      }
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, ref])
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1400)
    })
  }, [])
  return [copied, copy]
}

/** Puts text on the clipboard; a refused write is ignored. */
export function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? path
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * How many files differ from the last commit in this workspace, for the
 * Workbench badge. Polls lightly while the page is visible; the Changes view
 * reports fresher counts through the setter while it is open.
 */
export function useChangeCount(workspace: string, intervalMs = 15_000): [number | undefined, (count: number) => void] {
  const [count, setCount] = useState<number | undefined>()
  useEffect(() => {
    setCount(undefined)
    if (!workspace) return
    const controller = new AbortController()
    const poll = () => {
      if (document.visibilityState !== 'visible') return
      void workbenchApi.changes(workspace, controller.signal).then(
        summary => setCount(summary.git ? summary.files.length : undefined),
        () => undefined,
      )
    }
    poll()
    const timer = setInterval(poll, intervalMs)
    window.addEventListener('focus', poll)
    return () => {
      controller.abort()
      clearInterval(timer)
      window.removeEventListener('focus', poll)
    }
  }, [workspace, intervalMs])
  return [count, setCount]
}

/**
 * Keep a live view at its end: new content scrolls it down while the user is
 * following it, and for a moment after the user moves it themselves the viewport
 * stays where they put it. The rules live in lib/scroll.ts.
 *
 * The follow effect deliberately has no dependency list: it runs after every
 * render, which is exactly when content may have grown, and writing the current
 * end onto a viewport that is already there changes nothing.
 */
export function useScrollPinning(): {
  scroller: React.RefObject<HTMLDivElement | null>
  showJump: boolean
  onScroll: () => void
  jump: () => void
  pinToEnd: () => void
} {
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const lastUserInput = useRef(Number.NEGATIVE_INFINITY)
  const [showJump, setShowJump] = useState(false)

  const markUserInput = useCallback(() => {
    lastUserInput.current = performance.now()
  }, [])

  // Rolling, dragging or pressing a scrolling key counts as the user moving the
  // viewport, whatever the container then does with it.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const onKey = (event: KeyboardEvent) => {
      if (scrollsViewport(event.key) && !takesKeys(event.target)) markUserInput()
    }
    element.addEventListener('wheel', markUserInput, { passive: true })
    element.addEventListener('touchstart', markUserInput, { passive: true })
    element.addEventListener('touchmove', markUserInput, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      element.removeEventListener('wheel', markUserInput)
      element.removeEventListener('touchstart', markUserInput)
      element.removeEventListener('touchmove', markUserInput)
      document.removeEventListener('keydown', onKey)
    }
  }, [markUserInput])

  // Every scroll position decides on its own: the user may arrive back at the end
  // by scrolling, by the jump button or by shrinking the content.
  const onScroll = useCallback(() => {
    const element = scroller.current
    if (!element) return
    following.current = followsEnd(metricsOf(element))
    setShowJump(!following.current)
  }, [])

  useEffect(() => {
    const element = scroller.current
    if (!element || !following.current) return
    if (!canMoveViewport(performance.now(), lastUserInput.current)) return
    element.scrollTop = element.scrollHeight
  })

  const jump = useCallback(() => {
    const element = scroller.current
    following.current = true
    setShowJump(false)
    element?.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }, [])

  /** Follow the end again from scratch: a new session starts at its end. */
  const pinToEnd = useCallback(() => {
    const element = scroller.current
    following.current = true
    lastUserInput.current = Number.NEGATIVE_INFINITY
    setShowJump(false)
    if (element) element.scrollTop = element.scrollHeight
  }, [])

  return { scroller, showJump, onScroll, jump, pinToEnd }
}

/**
 * Fade the edge of a scroll container that is scrolled away from its end, so long
 * content does not end on a hard line. `.scroll-fade` in app.css draws the mask;
 * this only tracks which edges fade. Like the follow effect above it runs after
 * every render, because any render may have changed how much there is to scroll.
 */
export function useScrollFade(ref: React.RefObject<HTMLElement | null>, edges: ScrollEdges = 'both'): void {
  const update = useCallback(() => {
    const element = ref.current
    if (element) applyFade(element, metricsOf(element), edges)
  }, [ref, edges])

  useEffect(() => {
    update()
    const element = ref.current
    if (!element) return
    element.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      element.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [update])

  useEffect(update)
}
