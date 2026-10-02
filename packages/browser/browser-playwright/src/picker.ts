/**
 * The element picker: the user points at part of the page to talk about it.
 * A script in the page outlines the element under the pointer and resolves
 * with a description of the one clicked (or null on Escape / cancel). Clicks
 * are swallowed while picking, so choosing a button does not press it.
 */

export interface PickedElement {
  url: string
  tag: string
  /** Short CSS selector that finds the element on the page. */
  selector: string
  /** Accessible role and name when the element has them. */
  role?: string
  name?: string
  /** Visible text, trimmed. */
  text: string
  /** Opening part of the element's HTML. */
  html: string
  /** Position in CSS pixels of the viewport. */
  rect: { x: number; y: number; width: number; height: number }
}

export const PICK_CANCEL_SOURCE = 'window.__tnegaPickCancel?.()'

export const PICK_SOURCE = String.raw`new Promise(resolve => {
  window.__tnegaPickCancel?.()
  const accent = '#2f6fd0'
  const box = document.createElement('div')
  const label = document.createElement('div')
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid ' + accent + ';background:rgba(47,111,208,.12);border-radius:4px;transition:all 60ms ease-out;display:none'
  label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:' + accent + ';color:#fff;font:600 11px/1.6 system-ui,sans-serif;padding:0 6px;border-radius:4px;display:none;white-space:nowrap'
  document.documentElement.append(box, label)
  let current = null
  const describe = el => {
    const id = el.id ? '#' + el.id : ''
    const cls = [...el.classList].slice(0, 2).map(c => '.' + c).join('')
    return el.tagName.toLowerCase() + id + cls
  }
  const selectorOf = el => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id)
    const parts = []
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement && parts.length < 5; node = node.parentElement) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) { parts.unshift('#' + CSS.escape(node.id)); break }
      const tag = node.tagName.toLowerCase()
      const same = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName) : []
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : tag)
    }
    return parts.join(' > ')
  }
  const show = el => {
    const r = el.getBoundingClientRect()
    box.style.display = label.style.display = 'block'
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px'
    label.textContent = describe(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height)
    label.style.left = Math.max(0, r.left) + 'px'
    label.style.top = (r.top > 22 ? r.top - 20 : r.bottom + 2) + 'px'
  }
  const finish = value => {
    window.removeEventListener('mousemove', move, true)
    window.removeEventListener('click', click, true)
    window.removeEventListener('mousedown', swallow, true)
    window.removeEventListener('mouseup', swallow, true)
    window.removeEventListener('keydown', key, true)
    box.remove(); label.remove()
    delete window.__tnegaPickCancel
    resolve(value)
  }
  const move = event => {
    const el = document.elementFromPoint(event.clientX, event.clientY)
    if (el && el !== current && el !== box && el !== label) { current = el; show(el) }
  }
  const swallow = event => { event.preventDefault(); event.stopPropagation() }
  const click = event => {
    swallow(event)
    const el = document.elementFromPoint(event.clientX, event.clientY) || current
    if (!el) return finish(null)
    const r = el.getBoundingClientRect()
    const role = el.getAttribute('role') || undefined
    const name = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || undefined
    const html = el.outerHTML
    finish({
      url: location.href,
      tag: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      html: html.length > 600 ? html.slice(0, 600) + '…' : html,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    })
  }
  const key = event => { if (event.key === 'Escape') { swallow(event); finish(null) } }
  window.__tnegaPickCancel = () => finish(null)
  window.addEventListener('mousemove', move, true)
  window.addEventListener('mousedown', swallow, true)
  window.addEventListener('mouseup', swallow, true)
  window.addEventListener('click', click, true)
  window.addEventListener('keydown', key, true)
})`

/** A screenshot box around the element, padded and kept inside the viewport. */
export function pickClip(rect: PickedElement['rect'], viewport: { width: number; height: number }, pad = 8): { x: number; y: number; width: number; height: number } | undefined {
  const x = Math.max(0, Math.floor(rect.x - pad))
  const y = Math.max(0, Math.floor(rect.y - pad))
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width + pad))
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height + pad))
  if (right - x < 2 || bottom - y < 2) return undefined
  return { x, y, width: right - x, height: bottom - y }
}
