/**
 * The agent browser seen from the web app: the server streams screencast
 * frames of the (headless) page, and the user's pointer and keys go back to
 * it. The desktop app shows a native view instead (see desktop-browser.ts).
 */

export type LiveEvent =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'state'; url: string; title: string }

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
    if (type === 'state') {
      return { type, url: String(Reflect.get(parsed, 'url') ?? ''), title: String(Reflect.get(parsed, 'title') ?? '') }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Follow the live stream until `signal` aborts; reconnects are the caller's job. */
export async function streamBrowserLive(onEvent: (event: LiveEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch('/api/browser/live', { headers: { ...HEADERS, accept: 'text/event-stream' }, signal })
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
