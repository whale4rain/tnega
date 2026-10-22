/**
 * Scroll `rail` sideways, and nothing around it, just enough to show `tab`. Unlike `scrollIntoView`
 * it never scrolls an ancestor, so revealing a tab in a folded panel cannot shift the app frame.
 */
export function revealInRail(rail: HTMLElement, tab: Element): void {
  const bounds = rail.getBoundingClientRect()
  const item = tab.getBoundingClientRect()
  if (item.left < bounds.left) rail.scrollLeft -= bounds.left - item.left
  // A tab wider than the rail lines up with its start.
  else if (item.right > bounds.right) rail.scrollLeft += Math.min(item.right - bounds.right, item.left - bounds.left)
}
