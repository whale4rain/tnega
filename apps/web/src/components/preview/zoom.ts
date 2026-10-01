import { useCallback, useEffect, useState, type RefObject } from 'react'

/** Zoom steps offered by the − / + buttons and Ctrl+wheel. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const

export type ZoomSetting = number | 'fit'

/** Next step up or down from `current`, staying within the steps. */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find(step => step > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
  return [...ZOOM_STEPS].reverse().find(step => step < current - 0.001) ?? ZOOM_STEPS[0]
}

/** The scale that makes `naturalWidth` fill `available`, clamped to the step range. */
export function fitZoom(available: number, naturalWidth: number): number {
  if (!(available > 0 && naturalWidth > 0)) return 1
  const min = ZOOM_STEPS[0]
  const max = ZOOM_STEPS[ZOOM_STEPS.length - 1]
  return Math.min(max, Math.max(min, Math.floor((available / naturalWidth) * 100) / 100))
}

/**
 * Zoom for a preview pane. `content` is the element that gets CSS `zoom`; `measure` picks
 * the thing whose width "fit" should match (a docx page, the sheet grid, the slide).
 * `contentKey` changes when the content element appears, so fitting starts once it exists.
 */
export function usePreviewZoom(
  viewport: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  measure: string,
  initial: ZoomSetting,
  contentKey: unknown,
): { zoom: number, setting: ZoomSetting, setSetting: (value: ZoomSetting) => void, step: (direction: 1 | -1) => void } {
  const [setting, setSetting] = useState<ZoomSetting>(initial)
  const [fit, setFit] = useState(1)
  const zoom = setting === 'fit' ? fit : setting

  const refit = useCallback(() => {
    const outer = viewport.current
    const inner = content.current
    const target = inner?.querySelector<HTMLElement>(measure)
    if (!outer || !inner || !target) return
    // getBoundingClientRect includes the current zoom; divide it back out for the natural width.
    const current = Number(inner.style.zoom || 1) || 1
    const natural = target.getBoundingClientRect().width / current
    const styles = getComputedStyle(outer)
    const available = outer.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight)
    setFit(fitZoom(available, natural))
  }, [viewport, content, measure])

  // Re-fit when the pane resizes or the viewer finishes drawing (it renders asynchronously).
  useEffect(() => {
    if (setting !== 'fit') return
    const outer = viewport.current
    const inner = content.current
    if (!outer || !inner) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(refit, 50)
    }
    schedule()
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    resize?.observe(outer)
    const mutations = new MutationObserver(schedule)
    mutations.observe(inner, { childList: true, subtree: true })
    return () => {
      clearTimeout(timer)
      resize?.disconnect()
      mutations.disconnect()
    }
  }, [setting, refit, viewport, content, contentKey])

  // Ctrl / ⌘ + wheel zooms the preview instead of the whole app.
  useEffect(() => {
    const outer = viewport.current
    if (!outer) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setSetting(stepZoom(zoom, event.deltaY < 0 ? 1 : -1))
    }
    outer.addEventListener('wheel', onWheel, { passive: false })
    return () => outer.removeEventListener('wheel', onWheel)
  }, [viewport, zoom])

  const step = useCallback((direction: 1 | -1) => setSetting(stepZoom(zoom, direction)), [zoom])
  return { zoom, setting, setSetting, step }
}
