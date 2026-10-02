/**
 * The agent browser seen from the web app: the server streams screencast
 * frames of the (headless) page, and the user's pointer and keys go back to
 * it. The desktop app shows a native view instead (see desktop-browser.ts).
 */

export interface LiveTab {
  id: string
  url: string
  title: string
  active: boolean
}

export type LiveEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'state'; url: string; title: string }
  | { type: 'tabs'; tabs: LiveTab[] }

export interface PickedElement {
  url: string
  tag: string
  selector: string
  role?: string
  name?: string
  text: string
  html: string
}

export type LiveInput =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; text: string }

const HEADERS = { 'x-tnega-client': '1', 'content-type': 'application/json' }

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
}

export async function browserAvailable(): Promise<boolean> {
  try {
    const response = await fetch('/api/browser', { headers: HEADERS })
    if (!response.ok) return false
    const body: unknown = await response.json()
    return Boolean(body && typeof body === 'object' && Reflect.get(body, 'available') === true)
  } catch {
    return false
  }
}

export const sendBrowserInput = (input: LiveInput) => post('/api/browser/input', input)
export const navigateBrowser = (url: string) => post('/api/browser/navigate', { url })
export const browserCommand = (command: 'back' | 'forward' | 'reload') => post('/api/browser/command', { command })
export const setBrowserViewport = (width: number, height: number) => post('/api/browser/viewport', { width, height })
export const browserTab = (action: 'new' | 'select' | 'close', id?: string) => post('/api/browser/tabs', { action, ...(id ? { id } : {}) })
export const cancelPick = () => post('/api/browser/pick/cancel', {})

/** Wait for the user to click an element in the page; undefined when they cancel. */
export async function pickElement(): Promise<{ element: PickedElement; image?: { mediaType: 'image/jpeg'; data: string } } | undefined> {
  const response = await fetch('/api/browser/pick', { method: 'POST', headers: HEADERS, body: '{}' })
  if (!response.ok) throw new Error(`/api/browser/pick: ${response.status}`)
  return parsePickResult(await response.json())
}

const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

export function parsePickResult(body: unknown): { element: PickedElement; image?: { mediaType: 'image/jpeg'; data: string } } | undefined {
  if (!body || typeof body !== 'object') return undefined
  const raw: unknown = Reflect.get(body, 'element')
  if (!raw || typeof raw !== 'object') return undefined
  const tag = str(Reflect.get(raw, 'tag'))
  const selector = str(Reflect.get(raw, 'selector'))
  if (!tag || !selector) return undefined
  const role = str(Reflect.get(raw, 'role'))
  const name = str(Reflect.get(raw, 'name'))
  const element: PickedElement = {
    url: str(Reflect.get(raw, 'url')) ?? '',
    tag,
    selector,
    text: str(Reflect.get(raw, 'text')) ?? '',
    html: str(Reflect.get(raw, 'html')) ?? '',
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
  }
  const image: unknown = Reflect.get(body, 'image')
  const data = image && typeof image === 'object' ? str(Reflect.get(image, 'data')) : undefined
  return { element, ...(data ? { image: { mediaType: 'image/jpeg' as const, data } } : {}) }
}

/** Short chip label for a picked element, e.g. `<button> "Add"`. */
export function pickedLabel(element: PickedElement): string {
  const name = element.name ?? element.text
  return name ? `<${element.tag}> ${name.length > 32 ? `${name.slice(0, 31)}…` : name}` : `<${element.tag}> ${element.selector.split(' > ').at(-1) ?? ''}`
}

/** What goes into the message so the model knows which element the user means. */
export function describePicked(element: PickedElement): string {
  const label = element.name ?? (element.text ? `"${element.text.slice(0, 80)}"` : '')
  return [
    `[Selected element on ${element.url}]`,
    `<${element.tag}> ${label}`.trim(),
    `selector: ${element.selector}`,
    element.html,
  ].join('\n')
}

/** Hand text and images to the conversation composer (see PromptBox). */
export const COMPOSER_INSERT = 'tnega:composer-insert'

/** A piece of context shown as a chip; its text is added to the message when sent. */
export interface ComposerContext {
  label: string
  text: string
}

export interface ComposerInsert {
  text?: string
  context?: ComposerContext
  images?: Array<{ type: 'image'; mediaType: 'image/jpeg' | 'image/png'; data: string; name?: string }>
}

export function insertIntoComposer(detail: ComposerInsert): void {
  window.dispatchEvent(new CustomEvent<ComposerInsert>(COMPOSER_INSERT, { detail }))
}

export function parseLiveFrame(frame: string): LiveEvent | undefined {
  let data = ''
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('data:')) data += line.slice(5).trimStart()
  }
  if (!data) return undefined
  try {
    const parsed: unknown = JSON.parse(data)
    if (!parsed || typeof parsed !== 'object') return undefined
    const type = Reflect.get(parsed, 'type')
    if (type === 'frame' && typeof Reflect.get(parsed, 'data') === 'string') {
      return { type, data: String(Reflect.get(parsed, 'data')), width: Number(Reflect.get(parsed, 'width')) || 0, height: Number(Reflect.get(parsed, 'height')) || 0 }
    }
    if (type === 'tabs') {
      const tabs = Reflect.get(parsed, 'tabs')
      return { type, tabs: Array.isArray(tabs) ? tabs.map((tab: Record<string, unknown>) => ({ id: String(tab.id), url: String(tab.url ?? ''), title: String(tab.title ?? ''), active: tab.active === true })) : [] }
    }
    if (type === 'state') {
      return { type, url: String(Reflect.get(parsed, 'url') ?? ''), title: String(Reflect.get(parsed, 'title') ?? '') }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Follow the live stream until `signal` aborts; reconnects are the caller's job. */
export async function streamBrowserLive(onEvent: (event: LiveEvent) => void, signal: AbortSignal, options: { frames?: boolean } = {}): Promise<void> {
  const response = await fetch(options.frames === false ? '/api/browser/live?frames=0' : '/api/browser/live', { headers: { ...HEADERS, accept: 'text/event-stream' }, signal })
  if (!response.ok || !response.body) throw new Error(`browser stream: ${response.status}`)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += value
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const event = parseLiveFrame(frame)
      if (event) onEvent(event)
    }
  }
}

/** Where a pointer event lands on the page, as fractions of the frame. */
export function pointAt(event: { clientX: number; clientY: number }, rect: { left: number; top: number; width: number; height: number }): { x: number; y: number } {
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  return {
    x: rect.width ? clamp((event.clientX - rect.left) / rect.width) : 0,
    y: rect.height ? clamp((event.clientY - rect.top) / rect.height) : 0,
  }
}

const NAMED_KEYS = new Set([
  'Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Insert',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
])

/**
 * Turn a keydown into page input: plain characters are typed as text,
 * named keys and shortcuts are pressed (Playwright key names, e.g. `Control+A`).
 */
export function keyInput(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): LiveInput | undefined {
  const chord = event.ctrlKey || event.metaKey || event.altKey
  if (event.key.length === 1 && !chord) return { kind: 'text', text: event.key }
  if (!NAMED_KEYS.has(event.key) && event.key.length !== 1) return undefined
  const modifiers = [
    event.ctrlKey ? 'Control' : '',
    event.metaKey ? 'Meta' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey && event.key.length !== 1 ? 'Shift' : '',
  ].filter(Boolean)
  return { kind: 'key', key: [...modifiers, event.key].join('+') }
}

const PICKED_HEADER = /^\[Selected element on [^\]]*\]$/u

/**
 * Split a sent message into the picked-element blocks it starts with and the
 * user's own words, so the timeline can show the blocks as chips again.
 */
export function splitPickedContext(message: string): { contexts: ComposerContext[]; rest: string } {
  const blocks = message.split(/\n{2,}/u)
  const contexts: ComposerContext[] = []
  while (blocks.length && PICKED_HEADER.test(blocks[0]!.split('\n')[0] ?? '')) {
    const block = blocks.shift()!
    const summary = block.split('\n')[1] ?? 'element'
    contexts.push({ label: summary.replace(/^(<[^>]+>) "(.*)"$/u, '$1 $2'), text: block })
  }
  return { contexts, rest: blocks.join('\n\n') }
}
