import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface ServiceMap {
    terminals: TerminalService
  }
}

/**
 * The Workbench terminal seam: the person's own shell, in a workspace, on a
 * real PTY. Not an agent tool: it runs with the person's rights, outside the
 * sandbox, the same as a terminal they would open themselves.
 *
 * Every method is asynchronous so the terminals can live on another machine
 * (`@tnega/terminal-remote`) as well as this one (`@tnega/terminal-local`).
 */

export interface TerminalInfo {
  id: string
  workspace: string
  title: string
  shell: string
  cols: number
  rows: number
  createdAt: number
  exited?: { code: number }
}

export type TerminalEvent =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number }

export interface TerminalSize {
  cols?: number
  rows?: number
}

/** A failure with the HTTP status the routes answer with. */
export class TerminalError extends Error {
  override name = 'TerminalError'

  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export interface Terminals {
  list(workspace?: string): Promise<TerminalInfo[]>
  create(workspace: string, size?: TerminalSize): Promise<TerminalInfo>
  /**
   * Replay the scrollback, then stream. `onEnd` runs when the stream stops
   * for a reason other than detaching (the machine went away). Returns the detach.
   */
  attach(id: string, listener: (event: TerminalEvent) => void, onEnd?: (reason: string) => void): Promise<() => void>
  write(id: string, data: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  close(id: string): Promise<void>
}

/** The Service Definition of `ctx.terminals`; one Provider per scope. */
export abstract class TerminalService extends Service implements Terminals {
  constructor(ctx: Context) {
    super(ctx, 'terminals')
  }

  abstract list(workspace?: string): Promise<TerminalInfo[]>
  abstract create(workspace: string, size?: TerminalSize): Promise<TerminalInfo>
  abstract attach(id: string, listener: (event: TerminalEvent) => void, onEnd?: (reason: string) => void): Promise<() => void>
  abstract write(id: string, data: string): Promise<void>
  abstract resize(id: string, cols: number, rows: number): Promise<void>
  abstract close(id: string): Promise<void>
}

/** Shape checks for values that crossed a wire. */
export function isTerminalInfo(value: unknown): value is TerminalInfo {
  if (value === null || typeof value !== 'object') return false
  const info = value as Partial<TerminalInfo>
  return typeof info.id === 'string' && typeof info.workspace === 'string' && typeof info.title === 'string'
    && typeof info.shell === 'string' && typeof info.cols === 'number' && typeof info.rows === 'number'
    && typeof info.createdAt === 'number'
}

export function isTerminalEvent(value: unknown): value is TerminalEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<{ type: string; data: unknown; code: unknown }>
  return (event.type === 'data' && typeof event.data === 'string') || (event.type === 'exit' && typeof event.code === 'number')
}

export const name = '@tnega/terminal'
