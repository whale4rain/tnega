/**
 * Vocabulary of the computer seam. The agent works on one top-level window at
 * a time. It aims either at an element of the window's latest element tree
 * (preferred: the driver can confirm it) or at a point in pixels of the
 * window's latest screenshot, never screen coordinates, so display scaling and
 * window position stay the Provider's business.
 */

export interface ComputerPoint {
  x: number
  y: number
}

/**
 * Where a pointer action lands: an element token from {@link ComputerTree}
 * (`<snapshotId>:<index>`), or a point of the latest screenshot. Never both.
 */
export type ComputerAim =
  | { element: string; x?: undefined; y?: undefined }
  | { element?: undefined; x: number; y: number }

/** An action inside one window that a batch can carry. */
export type ComputerStep =
  | ({ op: 'click'; windowId: number; button?: 'left' | 'right' | 'middle'; count?: number } & ComputerAim)
  /** Types into `element`, or into whatever has the keyboard focus in the window. */
  | { op: 'type'; windowId: number; text: string; element?: string }
  /** One key (`['enter']`) or a chord (`['ctrl', 'l']`), modifiers first. A single key may target `element`. */
  | { op: 'key'; windowId: number; keys: string[]; element?: string }
  | ({ op: 'scroll'; windowId: number; direction: 'up' | 'down' | 'left' | 'right'; amount?: number } & ComputerAim)
  | { op: 'drag'; windowId: number; from: ComputerPoint; to: ComputerPoint }
  /**
   * Rest the pointer on a point, for menus that open on hover, tooltips and
   * drag handles. Hover needs the real pointer: the window comes to the front
   * and the user's mouse moves.
   */
  | ({ op: 'hover'; windowId: number } & ComputerPoint)

export const COMPUTER_STEP_OPS: ReadonlySet<string> = new Set<ComputerStep['op']>(['click', 'type', 'key', 'scroll', 'drag', 'hover'])

/** Most steps a batch may carry. */
export const COMPUTER_MAX_STEPS = 64

export type ComputerAction =
  | ComputerStep
  /** Invoke a native menu item by its labels, e.g. `['File', 'Save As...']`. */
  | { op: 'menu'; windowId: number; path: string[] }
  /**
   * Run steps in one window in order, stopping at the first that fails.
   * `computer/pre-action` judges every step before any runs.
   */
  | { op: 'steps'; windowId: number; steps: ComputerStep[] }
  /** Start an app by name or command, or by `id` from {@link ComputerService.apps}, optionally opening URLs in it. */
  | { op: 'launch'; app: string; id?: string; urls?: string[] }
  /** The clipboard is shared by every app, so it is not tied to a window. */
  | { op: 'clipboard-read' }
  | { op: 'clipboard-write'; text: string }

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

/** An app on this machine, running or only installed. */
export interface ComputerApp {
  name: string
  /** Pass as `id` of a launch to start exactly this app. */
  id?: string
  running: boolean
  pid?: number
  /** Its open top-level windows. */
  windowIds: number[]
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

/** What the driver could tell about an action's effect. Only `confirmed` means it checked. */
export type ComputerEffect = 'confirmed' | 'unverifiable' | 'suspected_noop' | 'partial'

export interface ComputerActionResult {
  /** Short human-readable note from the driver, e.g. how the click was delivered. */
  note: string
  /** The window the action landed in; a launch reports the app's new window when it knows one. */
  windowId?: number
  effect?: ComputerEffect
  /** What a clipboard read found. */
  text?: string
  /** A batch: one entry per step that ran, the failed one last. */
  steps?: ComputerStepResult[]
}

export interface ComputerStepResult {
  ok: boolean
  note: string
}

export interface ComputerTreeOptions extends ComputerCallOptions {
  /** Keep only rows whose text contains this (case-insensitive), with their ancestors. */
  query?: string
  /** An earlier `snapshotId` of the same window: answer with what changed since. */
  since?: string
  maxElements?: number
  maxDepth?: number
}

/**
 * One read of a window's accessibility tree. Rows tagged `[N]` can be acted on
 * with the element token `<snapshotId>:N`; a newer read of the window makes
 * older tokens stale.
 */
export interface ComputerTree {
  windowId: number
  app: string
  title: string
  snapshotId: string
  /** Indented rows as the driver renders them. */
  markdown: string
  /** Elements in the whole window, and how many this read returned. */
  total: number
  returned: number
  /** The walk stopped at its budget; narrow with `query` or raise `maxElements`. */
  truncated: boolean
  /** With `since`: how the driver answered, e.g. `diff` or why it fell back to a full read. */
  sinceStatus?: string
}

export interface ComputerCallOptions {
  signal?: AbortSignal
}

/** `computer/pre-action`: rewrite `action`, or set `deny` to refuse it. A batch is judged step by step. */
export interface ComputerPreActionEvent {
  action: ComputerAction
  /** The target window, resolved before policy runs; absent for a launch or the clipboard. */
  window?: ComputerWindow
  deny?: string
}

/**
 * `computer/action`: every outcome of {@link ComputerService.act}. A batch that
 * ran reports each step that ran as its own event; a batch that failed before
 * running reports once, as itself.
 */
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
  /** The element token is from an older read; read the tree again. */
  | 'COMPUTER_STALE_ELEMENT'
  | 'COMPUTER_FAILED'

export class ComputerError extends Error {
  constructor(readonly code: ComputerErrorCode, message: string) {
    super(message)
    this.name = 'ComputerError'
  }
}
