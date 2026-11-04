import { Service, type Context } from '@tnega/core'

export * from './processes.js'

declare module '@tnega/core' {
  interface ServiceMap {
    process: ProcessService
  }
}

export interface ShellRequest {
  command: string
  cwd: string
  /** Child-only overrides; other host environment variables are inherited. */
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  maxBuffer?: number
  signal?: AbortSignal
  /**
   * Run outside any sandbox decorator. Set only by a tool whose call was
   * approved for escalation (`ToolExecuteOptions.approvedElevation`).
   */
  unsandboxed?: boolean
  /** Each chunk of output as it arrives, for a caller that reports progress. */
  onOutput?: OutputListener
}

/** A raw output chunk from a running child; decoding is the listener's job. */
export type OutputListener = (chunk: Buffer, stream: 'stdout' | 'stderr') => void

export interface ShellResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * One shell-free process run. `argv` is a plain argument vector, so no quoting
 * layer exists between the caller and the executable and a model-controlled
 * value can never be re-parsed as shell syntax.
 */
export interface ProcessRequest {
  /** Child-only overrides; other host environment variables are inherited. */
  env?: Readonly<Record<string, string>>
  /** Full argument vector; element 0 is the executable. */
  argv: readonly string[]
  cwd: string
  timeoutMs?: number
  maxBuffer?: number
  signal?: AbortSignal
  /** Each chunk of output as it arrives, for a caller that reports progress. */
  onOutput?: OutputListener
}

export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  /** True when stdout hit `maxBuffer`, so the capture is not a complete stream. */
  stdoutTruncated: boolean
}

export interface HttpRequest {
  url: string
  headers?: Record<string, string>
  signal?: AbortSignal
  maxBytes?: number
  allowPrivate?: boolean
}

export interface HttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
  truncated: boolean
}

/** A long-running command, e.g. a dev server, started without waiting for it to exit. */
export interface BackgroundShellRequest {
  command: string
  cwd: string
  /** Child-only overrides; other host environment variables are inherited. */
  env?: Readonly<Record<string, string>>
  /** See {@link ShellRequest.unsandboxed}. */
  unsandboxed?: boolean
}

export interface BackgroundProcessRequest {
  env?: Readonly<Record<string, string>>
  argv: readonly string[]
  cwd: string
}

/**
 * The Windows write sandbox cannot let a confined program create named pipes
 * for its own children (Node/libuv `spawn` with captured output: npm → vite →
 * esbuild, test runners, `execSync`). The pipe's default DACL only lets its
 * owner write and the owner is not a restricting SID, so the program sees
 * `spawn EPERM` (see docs/research/2026-10-04-windows-sandbox-named-pipes.md).
 */
const PIPE_DENIAL = /\bspawn(?:Sync)?\b[^\n]*?\bEPERM\b|listen EACCES[^\n]*\\pipe\\/

/** Whether `text` carries the Windows sandbox's named-pipe denial. */
export function isSandboxPipeDenial(text: string): boolean {
  return PIPE_DENIAL.test(text)
}

export const SANDBOX_PIPE_HINT = '[tnega] This command needs to start child processes and read their output, which the Windows sandbox cannot allow. '
  + 'If it is needed, run it again with escalate: true and a one-line justification; it then runs outside the sandbox after approval.'

/** Handle to a running child. Output is the combined stdout/stderr tail. */
export interface BackgroundProcess {
  readonly pid: number | undefined
  /** Set by a sandbox decorator when the process runs confined. */
  readonly sandboxed?: boolean
  /** Combined stdout and stderr, most recent `maxOutput` characters. */
  output(): string
  /** Exit code once exited, `null` when killed by a signal, `undefined` while running. */
  exitCode(): number | null | undefined
  /** Settles when the process exits. */
  readonly exited: Promise<number | null>
  /** Kill the whole process tree. */
  kill(): Promise<void>
}

export interface ExecutionProvider {
  runShell(request: ShellRequest): Promise<ShellResult>
  runProcess(request: ProcessRequest): Promise<ProcessResult>
  fetchHttp(request: HttpRequest): Promise<HttpResponse>
  /** Start a shell command in the background; absent when the boundary cannot. */
  startShell?(request: BackgroundShellRequest): Promise<BackgroundProcess>
  /** Start an argv process in the background; absent when the boundary cannot. */
  startProcess?(request: BackgroundProcessRequest): Promise<BackgroundProcess>
  /** One sentence on how commands are written on this boundary's shell, for the `shell` tool's description. */
  describeShell?(): string
}

/** Characters of output a background process keeps. */
export const BACKGROUND_OUTPUT_LIMIT = 64 * 1024

/**
 * The process seam's Service Definition: owns `ctx.process`.
 *
 * Commands, shell-free processes and HTTP fetches of a scope run through
 * here, so the machine they run on can change: the local Provider
 * (`@tnega/process-local`) spawns on this computer, a remote Provider sends
 * the same calls to a daemon. Decorators (the sandbox in
 * `@tnega/execution-sandbox`, secrets in `@tnega/execution-secrets`) wrap an
 * {@link ExecutionProvider} value before the composition layer provides it,
 * so a scope with a sandbox never reaches the undecorated boundary.
 *
 * One Provider per scope; a second one in the same scope fails at mount.
 */
export abstract class ProcessService extends Service implements ExecutionProvider {
  constructor(ctx: Context) {
    super(ctx, 'process')
  }

  abstract runShell(request: ShellRequest): Promise<ShellResult>
  abstract runProcess(request: ProcessRequest): Promise<ProcessResult>
  abstract fetchHttp(request: HttpRequest): Promise<HttpResponse>
  /** Start a shell command in the background; absent when the boundary cannot. */
  startShell?: (request: BackgroundShellRequest) => Promise<BackgroundProcess>
  /** Start an argv process in the background; absent when the boundary cannot. */
  startProcess?: (request: BackgroundProcessRequest) => Promise<BackgroundProcess>
  /** See {@link ExecutionProvider.describeShell}. */
  describeShell?: () => string
}

/**
 * `ctx.process` backed by one {@link ExecutionProvider} value: the local
 * boundary, a remote one, or a decorated chain of either. Background starts
 * exist only when the boundary has them.
 */
export class ProcessBoundary extends ProcessService {
  constructor(ctx: Context, readonly boundary: ExecutionProvider) {
    super(ctx)
    const shell = boundary.startShell
    if (shell) this.startShell = async request => await shell.call(boundary, request)
    const start = boundary.startProcess
    if (start) this.startProcess = async request => await start.call(boundary, request)
    const describe = boundary.describeShell
    if (describe) this.describeShell = () => describe.call(boundary)
  }

  override async runShell(request: ShellRequest): Promise<ShellResult> {
    return await this.boundary.runShell(request)
  }

  override async runProcess(request: ProcessRequest): Promise<ProcessResult> {
    return await this.boundary.runProcess(request)
  }

  override async fetchHttp(request: HttpRequest): Promise<HttpResponse> {
    return await this.boundary.fetchHttp(request)
  }
}

/**
 * Provide `ctx.process` from an {@link ExecutionProvider} value. The
 * composition layer builds the chain (Provider plus decorators) and mounts it
 * here once per scope.
 */
export const processBoundary = {
  name: 'process-boundary',
  apply(ctx: Context, config: { boundary: ExecutionProvider }): void {
    new ProcessBoundary(ctx, config.boundary)
  },
}

export default ProcessService

export const name = '@tnega/process'
