import { resolve } from 'node:path'
import type { Context } from '@tnega/core'
import {
  describeShell,
  localExecutionProvider,
  ProcessRegistry,
  systemShell,
  type ExecutionProvider,
} from '@tnega/execution'
import {
  ESCALATE_HINT,
  ESCALATE_PROPERTIES,
  escalated,
  optionalNumber,
  optionalString,
  record,
  resolveInside,
  stringField,
  type ToolDefinition,
  type ToolExecuteOptions,
} from '@tnega/tools'

/** The model-visible `shell` tool for one workspace. */
export interface ToolShellConfig {
  /** Workspace root; the command's `cwd` is resolved against it and fenced inside it. */
  cwd?: string
  /** Let `cwd` leave the workspace (the `bypass` permission). */
  allowOutsideWorkspace?: boolean | (() => boolean | Promise<boolean>)
  /** Default timeout of one command. */
  timeoutMs?: number
  /** Byte cap for captured stdout plus stderr. */
  maxOutputBytes?: number
  /** The execution boundary the command runs on (a sandbox decorator in practice). */
  execution?: ExecutionProvider
  /** Background processes shared beyond this plugin (the web server's per-workspace registry). */
  processes?: ProcessRegistry
  /**
   * Declare the `runInBackground` parameter. The jobs plugin honours it;
   * without that plugin the flag is refused rather than silently run inline.
   * Defaults to on when this config can start processes at all.
   */
  backgroundJobs?: boolean
}

async function enabled(value: boolean | (() => boolean | Promise<boolean>)): Promise<boolean> {
  return typeof value === 'function' ? await value() : value
}

/** Decode each stream incrementally, so a character split across chunks arrives whole. */
function progressDecoder(progress: (output: string) => void): (chunk: Buffer, stream: 'stdout' | 'stderr') => void {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
  return (chunk, stream) => {
    const text = decoders[stream].decode(chunk, { stream: true })
    if (text) progress(text)
  }
}

/** Where a long command belongs: a timeout expires, it does not background. */
const BACKGROUND_HINT = 'Long commands (downloads, installs, builds, full test suites) need a larger timeoutMs; on expiry the command is killed, not backgrounded.'

/**
 * Build `shell` without registering it.
 *
 * `processes` is the registry a background command lands in: the caller's
 * shared one, or `owned` when the caller made one for this tool alone.
 */
export function createShellTool(config: ToolShellConfig = {}, owned?: ProcessRegistry): ToolDefinition {
  const cwdRoot = config.cwd ?? process.cwd()
  const outside = config.allowOutsideWorkspace ?? false
  const execution = config.execution ?? localExecutionProvider
  const processes = config.processes ?? owned
  const shared = config.processes !== undefined
  const timeoutDefault = config.timeoutMs ?? 15_000
  const maxBuffer = config.maxOutputBytes ?? 1024 * 1024
  const background = config.backgroundJobs ?? Boolean(processes && execution.startShell)
  const resolveCwd = async (path: string): Promise<string> => await enabled(outside)
    ? resolve(cwdRoot, path)
    : await resolveInside(cwdRoot, path)

  const properties: Record<string, unknown> = {
    command: { type: 'string', description: 'shell command to run' },
    cwd: { type: 'string', description: 'working directory relative to the workspace' },
    timeoutMs: { type: 'number', description: 'optional timeout in milliseconds' },
  }
  if (background) {
    // Declared here, honoured by the jobs plugin: the tool owns the schema, the
    // job registry owns the work, and neither package depends on the other.
    properties.runInBackground = {
      type: 'boolean',
      description: 'run it as a background job and return a job id immediately (no timeout applies); read it with job_output',
    }
    properties.waitForUrlMs = {
      type: 'number',
      description: 'with runInBackground: wait this long for the command to print a local URL before answering',
    }
  }
  const tool: ToolDefinition = {
    schema: {
      name: 'shell',
      description: `Run a shell command inside the workspace and return { exitCode, stdout, stderr }. ${describeShell(systemShell())} ${BACKGROUND_HINT} ${ESCALATE_HINT}`,
      parameters: {
        type: 'object',
        properties: { ...properties, ...ESCALATE_PROPERTIES },
        required: ['command'],
      },
    },
    // The command may already have had its effect when a restart cut it off.
    interruption: 'confirm',
    async execute(input, options: ToolExecuteOptions) {
      const args = record(input)
      const command = stringField(args.command, 'command')
      const cwd = await resolveCwd(optionalString(args.cwd, 'cwd') ?? '.')
      const adopt = options.adoptBackgroundProcess
      if (args.runInBackground === true && !adopt) {
        throw new Error('this runtime cannot run background commands; run it in the foreground with a larger timeoutMs')
      }
      if (adopt) {
        const start = execution.startShell?.bind(execution)
        if (!start || !processes) throw new Error('this host cannot run background processes; run the command with shell and a timeout instead')
        const running = processes.running()
        if (running.length >= processes.maxProcesses) {
          throw new Error(`already running ${running.length} background processes (${running.map(entry => entry.command).join('; ')}); stop one with job_kill first`)
        }
        const started = await start({ command, cwd, ...(escalated(args, options) ? { unsandboxed: true } : {}) })
        const entry = processes.add(command, cwd, started)
        adopt({ entry, shared, stop: async () => { await processes.stop(entry.id) } })
        return { processId: entry.id, status: 'running', ...(started.pid !== undefined ? { pid: started.pid } : {}) }
      }
      const timeoutMs = optionalNumber(args.timeoutMs, 'timeoutMs') ?? timeoutDefault
      const result = await execution.runShell({
        command,
        cwd,
        timeoutMs,
        maxBuffer,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.progress ? { onOutput: progressDecoder(options.progress) } : {}),
        ...(escalated(args, options) ? { unsandboxed: true } : {}),
      })
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    },
  }
  // The jobs plugin turns `runInBackground` into a job (a dev server, a watcher).
  if (background) tool.metadata = { ...tool.metadata, backgroundProcess: true }
  return tool
}

/**
 * The shell domain's model-visible tool. High privilege: a composition mounts
 * it only when shell access was explicitly turned on.
 *
 * Mount: `await ctx.plugin(toolShell, { cwd, execution })`.
 */
export const toolShell = {
  name: 'tool-shell',
  inject: ['tools'],
  apply(ctx: Context, config: ToolShellConfig = {}): void {
    // Without a shared registry, background processes die with this plugin.
    const owned = config.processes ? undefined : new ProcessRegistry()
    if (owned) ctx.fiber.effect(() => () => { void owned.dispose() }, 'tool-shell/processes')
    ctx.tools.register(createShellTool(config, owned))
  },
}
