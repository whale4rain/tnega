import { randomUUID } from 'node:crypto'
import {
  decodeBytes,
  forwardService,
  type DaemonLink,
  type ExitNotification,
  type OutputNotification,
  type ProcessCallParams,
  type SandboxParams,
  type TailNotification,
} from '@tnega/daemon-protocol'
import type {
  BackgroundProcess,
  BackgroundProcessRequest,
  BackgroundShellRequest,
  ExecutionProvider,
  HttpRequest,
  HttpResponse,
  OutputListener,
  PipedProcessLauncher,
  ProcessRequest,
  ProcessResult,
  ShellRequest,
  ShellResult,
} from '@tnega/process'

export interface RemoteExecutionOptions {
  /** The workspace id the daemon announced; every call carries it. */
  workspaceId: string
  /**
   * The sandbox the runtime decided for each command, read per call so a
   * permission change applies at once. The daemon enforces it; without one
   * the daemon runs read-only.
   */
  sandbox?: () => SandboxParams | Promise<SandboxParams>
}

function isOutput(value: unknown): value is OutputNotification {
  return value !== null && typeof value === 'object'
    && typeof (value as OutputNotification).id === 'string' && typeof (value as OutputNotification).data === 'string'
}

function isTail(value: unknown): value is TailNotification {
  return value !== null && typeof value === 'object' && typeof (value as TailNotification).handle === 'string'
    && typeof (value as TailNotification).output === 'string'
}

function isExit(value: unknown): value is ExitNotification {
  return value !== null && typeof value === 'object' && typeof (value as ExitNotification).handle === 'string'
}

/** Pass a running call's output chunks to the caller's listener. */
function listen(link: DaemonLink, callId: string, onOutput: OutputListener | undefined): () => void {
  if (!onOutput) return () => {}
  return link.onNotification('process/output', params => {
    if (!isOutput(params) || params.id !== callId) return
    try {
      onOutput(decodeBytes(params.data), params.stream === 'stderr' ? 'stderr' : 'stdout')
    } catch {
      // Progress reporting must never break the run it observes.
    }
  })
}

/**
 * Collect background-process notifications while `process/start` is on its
 * way: a process that ends at once has its last output and exit sent before
 * the reply that names its handle.
 */
function collectEarly(link: DaemonLink): { take(handle: string): Early; stop(): void } {
  const tails = new Map<string, string>()
  const exits = new Map<string, number | null>()
  const offTail = link.onNotification('process/tail', params => { if (isTail(params)) tails.set(params.handle, params.output) })
  const offExit = link.onNotification('process/exit', params => { if (isExit(params)) exits.set(params.handle, params.exitCode) })
  const stop = (): void => { offTail(); offExit() }
  return {
    take(handle) {
      stop()
      const output = tails.get(handle)
      return {
        ...(output !== undefined ? { output } : {}),
        ...(exits.has(handle) ? { exitCode: exits.get(handle) ?? null } : {}),
      }
    },
    stop,
  }
}

interface Early { output?: string; exitCode?: number | null }

/** A background process on the daemon, followed through its notifications. */
function remoteBackground(link: DaemonLink, handle: string, pid: number | undefined, sandboxed: boolean, early: Early = {}): BackgroundProcess {
  let output = early.output ?? ''
  let code: number | null | undefined
  let settle: (code: number | null) => void = () => {}
  const exited = new Promise<number | null>(done => { settle = done })
  const stopTail = link.onNotification('process/tail', params => {
    if (isTail(params) && params.handle === handle) output = params.output
  })
  const finish = (exitCode: number | null): void => {
    if (code !== undefined) return
    code = exitCode
    stopTail()
    stopExit()
    stopClose()
    settle(exitCode)
  }
  const stopExit = link.onNotification('process/exit', params => {
    if (isExit(params) && params.handle === handle) finish(params.exitCode)
  })
  // The connection went away: the process is out of reach, report it gone.
  const stopClose = link.onClose(() => {
    if (code === undefined) output += '\n[tnega] lost the connection to the daemon running this process'
    finish(null)
  })
  if (early.exitCode !== undefined) finish(early.exitCode)
  return {
    pid,
    ...(sandboxed ? { sandboxed: true } : {}),
    output: () => output,
    exitCode: () => code,
    exited,
    async kill() {
      if (code !== undefined) return
      await link.call('process/kill', { handle }).catch(() => undefined)
      await Promise.race([exited, new Promise(done => setTimeout(done, 2_000).unref())])
    },
  }
}

/**
 * An `ExecutionProvider` whose commands run on a daemon, for one workspace.
 * The composition layer wraps it with the secrets decorator and provides it
 * as `ctx.process`; the sandbox is the daemon's to enforce, at the mode the
 * runtime sends with each call.
 */
export function remoteExecutionProvider(link: DaemonLink, options: RemoteExecutionOptions): ExecutionProvider {
  const sandbox = async (): Promise<{ sandbox?: SandboxParams }> => options.sandbox ? { sandbox: await options.sandbox() } : {}
  const base = async (request: { cwd: string; env?: Readonly<Record<string, string>>; timeoutMs?: number; maxBuffer?: number; onOutput?: OutputListener }, callId: string): Promise<ProcessCallParams> => ({
    workspaceId: options.workspaceId,
    callId,
    cwd: request.cwd,
    ...(request.env ? { env: { ...request.env } } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.maxBuffer !== undefined ? { maxBuffer: request.maxBuffer } : {}),
    ...(request.onOutput ? { stream: true } : {}),
    ...await sandbox(),
  })
  const provider: ExecutionProvider = {
    async runShell(request: ShellRequest): Promise<ShellResult> {
      const callId = randomUUID()
      const stop = listen(link, callId, request.onOutput)
      try {
        const result = await link.call('process/shell', {
          ...await base(request, callId),
          command: request.command,
          ...(request.unsandboxed ? { unsandboxed: true } : {}),
        }, request.signal ? { signal: request.signal } : {})
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
      } finally {
        stop()
      }
    },
    async runProcess(request: ProcessRequest): Promise<ProcessResult> {
      const callId = randomUUID()
      const stop = listen(link, callId, request.onOutput)
      try {
        const result = await link.call('process/run', { ...await base(request, callId), argv: [...request.argv] }, request.signal ? { signal: request.signal } : {})
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, stdoutTruncated: result.stdoutTruncated === true }
      } finally {
        stop()
      }
    },
    async fetchHttp(request: HttpRequest): Promise<HttpResponse> {
      return await link.call('http/fetch', {
        url: request.url,
        ...(request.headers ? { headers: request.headers } : {}),
        ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
        ...(request.allowPrivate ? { allowPrivate: true } : {}),
      }, request.signal ? { signal: request.signal } : {})
    },
    async startShell(request: BackgroundShellRequest): Promise<BackgroundProcess> {
      const early = collectEarly(link)
      try {
        const started = await link.call('process/start', {
          workspaceId: options.workspaceId,
          cwd: request.cwd,
          command: request.command,
          ...(request.env ? { env: { ...request.env } } : {}),
          ...(request.unsandboxed ? { unsandboxed: true } : {}),
          ...await sandbox(),
        })
        return remoteBackground(link, started.handle, started.pid, started.sandboxed === true, early.take(started.handle))
      } finally {
        early.stop()
      }
    },
    async startProcess(request: BackgroundProcessRequest): Promise<BackgroundProcess> {
      const early = collectEarly(link)
      try {
        const started = await link.call('process/start', {
          workspaceId: options.workspaceId,
          cwd: request.cwd,
          argv: [...request.argv],
          ...(request.env ? { env: { ...request.env } } : {}),
          ...await sandbox(),
        })
        return remoteBackground(link, started.handle, started.pid, started.sandboxed === true, early.take(started.handle))
      } finally {
        early.stop()
      }
    },
  }
  const shell = link.capabilities.shell
  return shell ? { ...provider, describeShell: () => shell } : provider
}

function pipeEvent(value: unknown): { type: 'stdout' | 'stderr'; data: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const { type, data } = value as { type?: unknown; data?: unknown }
  return (type === 'stdout' || type === 'stderr') && typeof data === 'string' ? { type, data } : undefined
}

/**
 * Start long-lived stdin/stdout processes on a daemon (its `pipes` service),
 * for MCP servers in a box. Undefined when the daemon serves none: only a
 * daemon that is itself the sandbox does, and an older box image does not.
 */
export function remotePipes(link: DaemonLink): PipedProcessLauncher | undefined {
  if (!link.capabilities.services?.includes('pipes')) return undefined
  const pipes = forwardService(link, 'pipes')
  return async (request, handlers) => {
    const id = await pipes.call('start', [request.cwd, [...request.argv], { ...request.env }])
    if (typeof id !== 'string') throw new Error('the daemon sent a malformed process id')
    let closed = false
    const stream = await pipes.stream('attach', [id], {
      onEvent: value => {
        const event = pipeEvent(value)
        if (event?.type === 'stdout') handlers.onStdout(event.data)
        else if (event) handlers.onStderr?.(event.data)
      },
      onEnd: reason => { if (!closed) handlers.onExit?.(reason) },
    }).catch(async (error: unknown) => {
      await pipes.call('close', [id]).catch(() => undefined)
      throw error
    })
    return {
      write: async data => { await pipes.call('write', [id, data]) },
      close: async () => {
        if (closed) return
        closed = true
        // Ending the stream kills the process on the daemon; the call makes sure of it.
        await stream.close()
        await pipes.call('close', [id]).catch(() => undefined)
      },
    }
  }
}

export const name = '@tnega/process-remote'
