/**
 * Rules for long, live content: how far from the end still counts as following
 * it, how long the viewport keeps still after the user moves it themselves, and
 * which edge of a scroll container needs the fade mask. The behaviour and the
 * numbers are documented in docs/design/tnega-design.md §5.1.
 */

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** How far from the end still counts as the end, in px. */
export const PIN_TOLERANCE = 40

/** How long the viewport keeps still after the user rolls, drags or presses a scrolling key, in ms. */
export const USER_INPUT_COOLDOWN = 150

/** How close to an edge counts as being at it, in px. */
const EDGE_SLACK = 2

/** Which edges of a scroll container fade. A sticky header rules out the top one. */
export type ScrollEdges = 'both' | 'top' | 'bottom'

/** Distance between the end of the content and the end of the viewport, in px. */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight)
}

/** Whether the viewport is close enough to the end to keep following it. */
export function followsEnd(metrics: ScrollMetrics, tolerance = PIN_TOLERANCE): boolean {
  return distanceFromBottom(metrics) <= tolerance
}

/**
 * Whether new content may move the viewport. It may not while the user has just
 * moved it themselves: without the cooldown a single wheel tick above the end is
 * pulled back down by the next streamed token.
 */
export function canMoveViewport(now: number, lastUserInputAt: number, cooldown = USER_INPUT_COOLDOWN): boolean {
  return now - lastUserInputAt > cooldown
}

/** Keys that scroll the nearest scrollable ancestor when they are not typed into a field. */
export function scrollsViewport(key: string): boolean {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'PageUp' || key === 'PageDown' || key === 'Home' || key === 'End' || key === ' '
}

/** Whether the event target takes the key for itself (a field or a rich editor). */
export function takesKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true
  const editable = target.getAttribute('contenteditable')
  return target.isContentEditable || (editable !== null && editable !== 'false')
}

/** Which edges of this container are scrolled away from their end. */
export function fadeEdges(metrics: ScrollMetrics, edges: ScrollEdges = 'both'): { top: boolean; bottom: boolean } {
  return {
    top: edges !== 'bottom' && metrics.scrollTop > EDGE_SLACK,
    bottom: edges !== 'top' && distanceFromBottom(metrics) > EDGE_SLACK,
  }
}

/**
 * Write the fade state onto a scroll container. The mask itself is `.scroll-fade`
 * in app.css and is only applied while an edge is fading, so a container that
 * cannot fade paints exactly as it did before.
 */
export function applyFade(element: HTMLElement, metrics: ScrollMetrics, edges: ScrollEdges = 'both'): { top: boolean; bottom: boolean } {
  const fading = fadeEdges(metrics, edges)
  element.classList.toggle('is-fading-top', fading.top)
  element.classList.toggle('is-fading-bottom', fading.bottom)
  element.classList.toggle('is-fading', fading.top || fading.bottom)
  return fading
}

/** The metrics of a live scroll container. */
export function metricsOf(element: HTMLElement): ScrollMetrics {
  return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }
}
