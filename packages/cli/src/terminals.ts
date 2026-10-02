import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/**
 * The Workbench terminal: the user's own shell, in a workspace, on a real PTY.
 *
 * This is not an agent tool — it runs with the user's rights, outside the
 * sandbox, the same as the terminal they would open themselves. It is only
 * reachable through the loopback server's API, behind its client header.
 *
 * Each terminal keeps a bounded scrollback, so a panel that reattaches (after
 * switching tabs or reloading) replays what it missed. Terminals end with the
 * server.
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

/** The part of node-pty's `IPty` this module uses. */
export interface PtyLike {
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type PtySpawn = (shell: string, args: string[], options: {
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
  name: string
}) => PtyLike

const SCROLLBACK_BYTES = 256 * 1024
const MAX_TERMINALS = 12

export class TerminalError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

interface Entry {
  info: TerminalInfo
  pty: PtyLike
  scrollback: string
  listeners: Set<(event: TerminalEvent) => void>
}

/** The login shell for this platform: PowerShell 7, then Windows PowerShell; `$SHELL` elsewhere. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): { shell: string; args: string[] } {
  if (platform === 'win32') {
    const pwsh = (env.PATH ?? env.Path ?? '').split(';').map(dir => resolve(dir, 'pwsh.exe')).find(existsSync)
    return { shell: pwsh ?? 'powershell.exe', args: ['-NoLogo'] }
  }
  return { shell: env.SHELL || '/bin/bash', args: ['-l'] }
}

/** node-pty is a native module; it loads on first use so the server starts without it. */
async function loadSpawn(): Promise<PtySpawn> {
  try {
    const module = await import('@lydell/node-pty')
    return (shell, args, options) => module.spawn(shell, args, options)
  } catch (cause) {
    throw new TerminalError(`terminal is unavailable on this host: ${cause instanceof Error ? cause.message : String(cause)}`, 501)
  }
}

export class TerminalManager {
  private readonly entries = new Map<string, Entry>()
  private next = 1
  private spawner: Promise<PtySpawn> | undefined

  constructor(private readonly options: { spawn?: PtySpawn; shell?: { shell: string; args: string[] } } = {}) {}

  list(workspace?: string): TerminalInfo[] {
    return [...this.entries.values()]
      .map(entry => entry.info)
      .filter(info => workspace === undefined || info.workspace === resolve(workspace))
  }

  async create(workspace: string, size: { cols?: number; rows?: number } = {}): Promise<TerminalInfo> {
    if (this.entries.size >= MAX_TERMINALS) throw new TerminalError(`at most ${MAX_TERMINALS} terminals can be open`, 429)
    const spawn = this.options.spawn ?? await (this.spawner ??= loadSpawn())
    const { shell, args } = this.options.shell ?? defaultShell()
    const cols = clamp(size.cols, 20, 500, 100)
    const rows = clamp(size.rows, 5, 200, 30)
    const cwd = resolve(workspace)
    const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    const pty = spawn(shell, args, { cols, rows, cwd, env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, name: 'xterm-256color' })
    const id = String(this.next++)
    const entry: Entry = {
      info: { id, workspace: cwd, title: basename(shell).replace(/\.exe$/i, ''), shell, cols, rows, createdAt: Date.now() },
      pty,
      scrollback: '',
      listeners: new Set(),
    }
    pty.onData(data => {
      entry.scrollback = (entry.scrollback + data).slice(-SCROLLBACK_BYTES)
      for (const listener of entry.listeners) listener({ type: 'data', data })
    })
    pty.onExit(({ exitCode }) => {
      entry.info.exited = { code: exitCode }
      for (const listener of entry.listeners) listener({ type: 'exit', code: exitCode })
    })
    this.entries.set(id, entry)
    return entry.info
  }

  /** Replays the scrollback, then streams; returns the unsubscribe. */
  attach(id: string, listener: (event: TerminalEvent) => void): () => void {
    const entry = this.require(id)
    if (entry.scrollback) listener({ type: 'data', data: entry.scrollback })
    if (entry.info.exited) listener({ type: 'exit', code: entry.info.exited.code })
    entry.listeners.add(listener)
    return () => { entry.listeners.delete(listener) }
  }

  write(id: string, data: string): void {
    const entry = this.require(id)
    if (!entry.info.exited) entry.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.require(id)
    entry.info.cols = clamp(cols, 20, 500, entry.info.cols)
    entry.info.rows = clamp(rows, 5, 200, entry.info.rows)
    if (!entry.info.exited) entry.pty.resize(entry.info.cols, entry.info.rows)
  }

  close(id: string): void {
    const entry = this.require(id)
    this.entries.delete(id)
    entry.listeners.clear()
    if (!entry.info.exited) entry.pty.kill()
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.close(id)
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new TerminalError(`terminal not found: ${id}`, 404)
    return entry
  }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}
