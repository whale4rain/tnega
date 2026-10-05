import { isSandboxPipeDenial, SANDBOX_PIPE_HINT, type BackgroundProcess } from '@tnega/execution'

/** Local URLs a dev server prints, e.g. `http://localhost:5173/`. */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)(?::\d+)?(?:\/[^\s"'`)\]]*)?/giu
// eslint-disable-next-line no-control-regex -- terminal colour codes are control characters by definition
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Distinct local URLs in `text`, `0.0.0.0` rewritten to `localhost` so a browser can open them. */
export function localUrls(text: string): string[] {
  const found = new Set<string>()
  for (const match of stripAnsi(text).matchAll(LOCAL_URL)) {
    found.add(match[0].replace('://0.0.0.0', '://localhost').replace(/[.,;:]+$/u, ''))
  }
  return [...found]
}

export interface ProcessEntry {
  id: string
  command: string
  cwd: string
  startedAt: number
  process: BackgroundProcess
}

export interface ProcessSnapshot {
  id: string
  command: string
  cwd: string
  startedAt: number
  pid?: number
  status: 'running' | 'stopping' | 'completed' | 'failed' | 'killed'
  exitCode?: number | null
  urls: string[]
}

/**
 * Background processes started by agents in one workspace, through `shell`
 * run as a background job (`job_start`). The web server keeps one per
 * workspace so a dev server outlives the run, and the runtime, that started
 * it; without one, the shell tool owns a private registry that dies with it.
 */
export class ProcessRegistry {
  readonly entries = new Map<string, ProcessEntry>()
  private _next = 1
  private readonly _stopping = new Set<string>()
  private readonly _stopped = new Set<string>()

  constructor(readonly maxProcesses = 4) {}

  running(): ProcessEntry[] {
    return [...this.entries.values()].filter(entry => entry.process.exitCode() === undefined)
  }

  add(command: string, cwd: string, process: BackgroundProcess): ProcessEntry {
    const entry: ProcessEntry = { id: `p${this._next++}`, command, cwd, startedAt: Date.now(), process }
    this.entries.set(entry.id, entry)
    return entry
  }

  list(): ProcessSnapshot[] {
    return [...this.entries.values()].map(entry => this.snapshot(entry))
  }

  read(id: string): { process: ProcessSnapshot; output: string; note?: string; hint?: string } | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    const output = entry.process.output()
    return { process: this.snapshot(entry), output: tail(stripAnsi(output), 64_000), ...processNotes(entry.process, output, true) }
  }

  async stop(id: string): Promise<ProcessSnapshot | undefined> {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    if (entry.process.exitCode() !== undefined) return this.snapshot(entry)
    this._stopping.add(id)
    try { await entry.process.kill(); this._stopped.add(id) }
    finally { this._stopping.delete(id) }
    return this.snapshot(entry)
  }

  private snapshot(entry: ProcessEntry): ProcessSnapshot {
    const exitCode = entry.process.exitCode()
    return {
      id: entry.id, command: entry.command, cwd: entry.cwd, startedAt: entry.startedAt,
      ...(entry.process.pid !== undefined ? { pid: entry.process.pid } : {}),
      status: exitCode === undefined ? (this._stopping.has(entry.id) ? 'stopping' : 'running')
        : exitCode === null || this._stopped.has(entry.id) ? 'killed' : exitCode === 0 ? 'completed' : 'failed',
      ...(exitCode !== undefined ? { exitCode } : {}), urls: localUrls(entry.process.output()),
    }
  }

  async dispose(): Promise<void> {
    const all = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(all.map(entry => entry.process.kill().catch(() => {})))
  }
}

function tail(text: string, chars = 4_000): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text
}

/**
 * On Windows a confined dev server usually looks healthy at first: vite,
 * webpack and test runners start their helper processes lazily, and those
 * fail only on the first request. Say so up front, and point at the fix
 * once the denial shows up in the output.
 */
const SANDBOXED_SERVER_NOTE = 'Runs inside the Windows sandbox. Servers and build tools that start helper processes (vite/esbuild, webpack, jest) can look ready here and then fail requests with spawn EPERM; check the page or job_output before relying on it.'

/** A note when a confined process starts, and the fix once its output shows the sandbox denial. */
export function processNotes(process: BackgroundProcess, output: string, starting: boolean): { note?: string; hint?: string } {
  if (globalThis.process.platform !== 'win32' || process.sandboxed !== true) return {}
  if (isSandboxPipeDenial(output)) return { hint: SANDBOX_PIPE_HINT }
  return starting ? { note: SANDBOXED_SERVER_NOTE } : {}
}

