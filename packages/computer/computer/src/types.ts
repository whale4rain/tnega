/**
 * Vocabulary of the computer seam. The agent works on one top-level window at
 * a time; points are pixels of that window's latest screenshot, never screen
 * coordinates, so display scaling and window position stay the Provider's
 * business.
 */

export interface ComputerPoint {
  x: number
  y: number
}

export type ComputerAction =
  | { op: 'click'; windowId: number; x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: number }
  /** Types into whatever has the keyboard focus in the window. */
  | { op: 'type'; windowId: number; text: string }
  /** One key (`['enter']`) or a chord (`['ctrl', 'l']`), modifiers first. */
  | { op: 'key'; windowId: number; keys: string[] }
  | { op: 'scroll'; windowId: number; x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; amount?: number }
  | { op: 'drag'; windowId: number; from: ComputerPoint; to: ComputerPoint }
  /** Start an app by name or command, optionally opening URLs in it. */
  | { op: 'launch'; app: string; urls?: string[] }

export type ComputerActionOp = ComputerAction['op']

export interface ComputerWindow {
  id: number
  pid: number
  /** The owning application as the OS names it, e.g. `Chromium-browser` or `chrome.exe`. */
  app: string
  title: string
  bounds: { x: number; y: number; width: number; height: number }
  onScreen: boolean
}

export interface ComputerScreenshot {
  windowId: number
  app: string
  title: string
  /** Pixel size of the image; points for actions are in this frame. */
  width: number
  height: number
  mediaType: 'image/png' | 'image/jpeg'
  /** Base64 without a `data:` prefix. */
  data: string
}

export interface ComputerRegion {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface ComputerActionResult {
  /** Short human-readable note from the driver, e.g. how the click was delivered. */
  note: string
  /** The window the action landed in; a launch reports the app's new window when it knows one. */
  windowId?: number
}

export interface ComputerCallOptions {
  signal?: AbortSignal
}

/** `computer/pre-action`: rewrite `action`, or set `deny` to refuse it. */
export interface ComputerPreActionEvent {
  action: ComputerAction
  /** The target window, resolved before policy runs; absent for a launch. */
  window?: ComputerWindow
  deny?: string
}

/** `computer/action`: every outcome of {@link ComputerService.act}. */
export interface ComputerActionEvent {
  action: ComputerAction
  window?: ComputerWindow
  ok: boolean
  result?: ComputerActionResult
  error?: { code: ComputerErrorCode; message: string }
  startedAt: number
  durationMs: number
}

export type ComputerErrorCode =
  /** No driver on this machine, or it cannot run here. */
  | 'COMPUTER_UNAVAILABLE'
  | 'COMPUTER_DENIED'
  /** The window id is not an open window any more. */
  | 'COMPUTER_NO_WINDOW'
  | 'COMPUTER_ABORTED'
  | 'COMPUTER_FAILED'

export class ComputerError extends Error {
  constructor(readonly code: ComputerErrorCode, message: string) {
    super(message)
    this.name = 'ComputerError'
  }
}
