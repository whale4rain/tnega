import type { BackgroundProcess, ExecutionProvider } from '@tnega/execution'
import type { ToolDefinition, ToolExecuteOptions } from './index.js'

/** Names of the background-process tools. */
export const PROCESS_TOOL_NAMES: readonly string[] = ['process_start', 'process_output', 'process_list', 'process_stop']

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

interface Entry {
  id: string
  command: string
  cwd: string
  startedAt: number
  process: BackgroundProcess
  /** Output already returned by `process_output`. */
  read: number
}

export interface ProcessToolsConfig {
  execution: ExecutionProvider
  /** Resolve a workspace-relative cwd the same way `shell` does. */
  resolveCwd: (cwd: string) => Promise<string>
  /** Running processes allowed at once. */
  maxProcesses?: number
}

function tail(text: string, chars = 4_000): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text
}

function status(entry: Entry): string {
  const code = entry.process.exitCode()
  return code === undefined ? 'running' : `exited (${code ?? 'killed'})`
}

/**
 * Long-running commands for the agent, such as a dev server it then opens in
 * the browser. Processes run through the same execution boundary (and so the
 * same sandbox) as `shell`, and are killed when the tools are disposed.
 */
export function createProcessTools(config: ProcessToolsConfig): { tools: ToolDefinition[]; dispose: () => Promise<void> } {
  const start = config.execution.startShell?.bind(config.execution)
  const entries = new Map<string, Entry>()
  let next = 1
  const maxProcesses = config.maxProcesses ?? 4

  const find = (input: unknown): Entry => {
    const id = input && typeof input === 'object' ? (input as Record<string, unknown>).id : undefined
    const entry = typeof id === 'string' ? entries.get(id) : undefined
    if (!entry) throw new Error(`no process ${String(id)}; see process_list`)
    return entry
  }

  const tools: ToolDefinition[] = start ? [
    {
      schema: {
        name: 'process_start',
        description: 'Start a long-running command in the background, such as a dev server (`npm run dev`) or a watcher, and return its id, first output and any local URLs it printed. Use `shell` for commands that finish on their own.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'shell command to run' },
            cwd: { type: 'string', description: 'working directory relative to the workspace' },
            waitForUrlMs: { type: 'number', description: 'how long to wait for a local URL in the output (default 15000, 0 to return at once)' },
          },
          required: ['command'],
        },
      },
      timeoutMs: 120_000,
      async execute(input: unknown, options: ToolExecuteOptions) {
        const args = input && typeof input === 'object' ? input as Record<string, unknown> : {}
        if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('command must be a non-empty string')
        const running = [...entries.values()].filter(entry => entry.process.exitCode() === undefined)
        if (running.length >= maxProcesses) throw new Error(`already running ${running.length} processes; stop one with process_stop first`)
        const cwd = await config.resolveCwd(typeof args.cwd === 'string' ? args.cwd : '.')
        const process = await start!({ command: args.command, cwd })
        const id = `p${next++}`
        const entry: Entry = { id, command: args.command, cwd, startedAt: Date.now(), process, read: 0 }
        entries.set(id, entry)
        const waitMs = typeof args.waitForUrlMs === 'number' ? Math.min(Math.max(args.waitForUrlMs, 0), 60_000) : 15_000
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline && !options.signal?.aborted && process.exitCode() === undefined && localUrls(process.output()).length === 0) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        const output = process.output()
        entry.read = output.length
        return { id, status: status(entry), urls: localUrls(output), output: tail(stripAnsi(output)) }
      },
    },
    {
      schema: {
        name: 'process_output',
        description: 'Read new output from a background process since the last read (or all of it), plus its status and local URLs.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            all: { type: 'boolean', description: 'return the whole retained output instead of only new lines' },
          },
          required: ['id'],
        },
      },
      async execute(input: unknown) {
        const entry = find(input)
        const all = (input as Record<string, unknown>).all === true
        const output = entry.process.output()
        const fresh = all || output.length < entry.read ? output : output.slice(entry.read)
        entry.read = output.length
        return { id: entry.id, status: status(entry), urls: localUrls(output), output: tail(stripAnsi(fresh), 8_000) }
      },
    },
    {
      schema: { name: 'process_list', description: 'List background processes started in this session.', parameters: { type: 'object', properties: {} } },
      execute() {
        return [...entries.values()].map(entry => ({
          id: entry.id,
          command: entry.command,
          status: status(entry),
          urls: localUrls(entry.process.output()),
          startedAt: new Date(entry.startedAt).toISOString(),
        }))
      },
    },
    {
      schema: {
        name: 'process_stop',
        description: 'Stop a background process and everything it started.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      async execute(input: unknown) {
        const entry = find(input)
        await entry.process.kill()
        return { id: entry.id, status: status(entry) }
      },
    },
  ] : []

  return {
    tools,
    async dispose() {
      const running = [...entries.values()]
      entries.clear()
      await Promise.all(running.map(entry => entry.process.kill().catch(() => {})))
    },
  }
}
