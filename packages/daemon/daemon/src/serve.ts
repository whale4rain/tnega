import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Context } from '@tnega/core'
import { LocalWorkspaceFs } from '@tnega/fs-local'
import { sandboxedExecution } from '@tnega/execution-sandbox'
import type { FsWriteMode } from '@tnega/fs'
import { resolveInside } from '@tnega/fs-sandbox'
import {
  RpcError,
  RpcErrorCode,
  decodeBytes,
  encodeBytes,
  type DaemonMethod,
  type DaemonWorkspace,
  type HandlerContext,
  type ParamsOf,
  type Peer,
  type ProcessCallResult,
  type ResultOf,
  type SandboxParams,
  type StartParams,
} from '@tnega/daemon-protocol'
import type { BackgroundProcess, ExecutionProvider, OutputListener } from '@tnega/process'
import { localExecutionProvider, networkPolicy } from '@tnega/process-local'
import { canonicalPath, resolveSandboxPolicy, type SandboxNetworkRequest } from '@tnega/sandbox'
import { sandboxLocal } from '@tnega/sandbox-local'
import { StreamHub, type ExposedService, type StreamHubOptions } from './services.js'

/** How many mutating calls a daemon remembers by `callId`, for retries. */
const REMEMBERED_CALLS = 512
/** How often a background process's output tail is pushed while it changes. */
const TAIL_INTERVAL_MS = 500

export interface ServeOptions {
  workspaces: readonly DaemonWorkspace[]
  /**
   * The undecorated boundary commands run on. Defaults to this machine. The
   * daemon wraps it with the sandbox for every call, using the mode the
   * runtime sent (read-only when it sent none): the daemon enforces, it never
   * runs a command looser than asked.
   */
  execution?: ExecutionProvider
  /** Other Services this daemon answers through `service/call` and `stream/*`, by name. */
  services?: Readonly<Record<string, ExposedService>>
  streams?: StreamHubOptions
  /** Run when the daemon closes, after its streams stop (the services' own teardown). */
  onClose?: () => void | Promise<void>
}

interface Served {
  workspace: DaemonWorkspace
  fs: LocalWorkspaceFs
  sandboxScope: Context
}

/**
 * What one daemon serves: its workspaces' files, commands confined by the
 * local sandbox, background processes and HTTP. Built once per daemon and
 * reused across reconnects, so a retried call finds its first answer and a
 * background process survives a dropped connection.
 */
export class DaemonService {
  private readonly root = new Context()
  private readonly served = new Map<string, Promise<Served>>()
  private readonly calls = new Map<string, Promise<unknown>>()
  private readonly background = new Map<string, { process: BackgroundProcess; workspaceId: string }>()
  private readonly execution: ExecutionProvider
  private peer: Peer | undefined
  private closed = false
  private readonly streams: StreamHub

  constructor(private readonly options: ServeOptions) {
    this.execution = options.execution ?? localExecutionProvider
    this.streams = new StreamHub(options.streams)
  }

  /** The names of the Services this daemon forwards. */
  get services(): string[] {
    return Object.keys(this.options.services ?? {})
  }

  get workspaces(): readonly DaemonWorkspace[] {
    return this.options.workspaces
  }

  /** Serve on this peer; notifications for background processes go to the latest one. */
  attach(peer: Peer): void {
    this.peer = peer
    this.streams.attach(peer)
  }

  async handle(method: string, params: unknown, context: HandlerContext): Promise<unknown> {
    if (this.closed) throw new RpcError('daemon is closing', RpcErrorCode.CONNECTION_LOST)
    const typed = method as DaemonMethod
    const callId = (params as { callId?: unknown } | undefined)?.callId
    if (typeof callId === 'string') {
      const remembered = this.calls.get(callId)
      if (remembered) return await remembered
      const running = this.dispatch(typed, params, context)
      this.remember(callId, running)
      return await running
    }
    return await this.dispatch(typed, params, context)
  }

  /** Kill background processes, drop sandbox scopes. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all([...this.background.values()].map(entry => entry.process.kill().catch(() => undefined)))
    this.background.clear()
    this.calls.clear()
    this.streams.dispose()
    await this.options.onClose?.()
    await this.root.fiber.dispose()
  }

  private remember(callId: string, running: Promise<unknown>): void {
    this.calls.set(callId, running)
    // A failed call may be retried for real; only answers are remembered.
    running.catch(() => { if (this.calls.get(callId) === running) this.calls.delete(callId) })
    for (const oldest of this.calls.keys()) {
      if (this.calls.size <= REMEMBERED_CALLS) break
      this.calls.delete(oldest)
    }
  }

  private workspace(id: unknown): Promise<Served> {
    if (typeof id !== 'string') throw new RpcError('workspaceId is required', RpcErrorCode.INVALID_PARAMS)
    const known = this.served.get(id)
    if (known) return known
    const workspace = this.options.workspaces.find(item => item.id === id)
    if (!workspace) throw new RpcError(`workspace ${id} is not served by this daemon`, RpcErrorCode.WORKSPACE_DENIED, { name: 'WorkspaceDeniedError', code: 'WORKSPACE_DENIED' })
    const opening = (async (): Promise<Served> => {
      const sandboxScope = this.root.isolate('sandbox')
      await sandboxScope.plugin(sandboxLocal, {
        workspaceRoot: canonicalPath(resolve(workspace.path)),
        upstreamProxy: () => networkPolicy().proxy,
      })
      // Files never leave the workspace on a daemon: `bypass` is not offered remotely.
      return { workspace, fs: new LocalWorkspaceFs(workspace.path), sandboxScope }
    })()
    this.served.set(id, opening)
    opening.catch(() => this.served.delete(id))
    return opening
  }

  /** The boundary for one call: the sandbox at the mode the runtime asked for. */
  private boundary(served: Served, sandbox: SandboxParams | undefined): ExecutionProvider {
    const policy = resolveSandboxPolicy({
      mode: sandbox?.mode ?? 'read-only',
      workspaceRoot: canonicalPath(resolve(served.workspace.path)),
      ...(sandbox?.sessionId !== undefined ? { sessionId: sandbox.sessionId } : {}),
      ...(isNetworkRequest(sandbox?.network) ? { network: sandbox.network } : {}),
    })
    return sandboxedExecution(served.sandboxScope, { inner: this.execution, policy })
  }

  private async cwd(served: Served, cwd: unknown): Promise<string> {
    if (typeof cwd !== 'string') throw new RpcError('cwd is required', RpcErrorCode.INVALID_PARAMS)
    return await resolveInside(served.workspace.path, cwd)
  }

  private stream(context: HandlerContext, wanted: boolean | undefined, callId: string | undefined): OutputListener | undefined {
    if (!wanted) return undefined
    const id = callId ?? String(context.id)
    return (chunk, stream) => this.peer?.notify('process/output', { id, stream, data: encodeBytes(chunk) })
  }

  private async dispatch(method: DaemonMethod, raw: unknown, context: HandlerContext): Promise<unknown> {
    switch (method) {
      case 'fs/realRoot': {
        const served = await this.workspace(param(raw, 'workspaceId'))
        return await served.fs.realRoot() satisfies ResultOf<'fs/realRoot'>
      }
      case 'fs/resolve': {
        const { workspaceId, path } = raw as ParamsOf<'fs/resolve'>
        return await (await this.workspace(workspaceId)).fs.resolve(text(path, 'path'))
      }
      case 'fs/stat': {
        const { workspaceId, path } = raw as ParamsOf<'fs/stat'>
        return await (await this.workspace(workspaceId)).fs.stat(text(path, 'path')) ?? null
      }
      case 'fs/read': {
        const { workspaceId, path, start, end } = raw as ParamsOf<'fs/read'>
        const fs = (await this.workspace(workspaceId)).fs
        const range = typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined
        return encodeBytes(await fs.readFile(text(path, 'path'), range))
      }
      case 'fs/write': {
        const { workspaceId, path, data, mode } = raw as ParamsOf<'fs/write'>
        const fs = (await this.workspace(workspaceId)).fs
        await fs.writeFile(text(path, 'path'), decodeBytes(text(data, 'data')), { mode: writeMode(mode), signal: context.signal })
        return null
      }
      case 'fs/list': {
        const { workspaceId, path } = raw as ParamsOf<'fs/list'>
        return await (await this.workspace(workspaceId)).fs.list(text(path, 'path'))
      }
      case 'fs/mkdir': {
        const { workspaceId, path } = raw as ParamsOf<'fs/mkdir'>
        await (await this.workspace(workspaceId)).fs.mkdir(text(path, 'path'))
        return null
      }
      case 'fs/remove': {
        const { workspaceId, path, recursive } = raw as ParamsOf<'fs/remove'>
        await (await this.workspace(workspaceId)).fs.remove(text(path, 'path'), { recursive: recursive === true })
        return null
      }
      case 'fs/rename': {
        const { workspaceId, from, to } = raw as ParamsOf<'fs/rename'>
        await (await this.workspace(workspaceId)).fs.rename(text(from, 'from'), text(to, 'to'))
        return null
      }
      case 'process/shell': {
        const params = raw as ParamsOf<'process/shell'>
        const served = await this.workspace(params.workspaceId)
        const onOutput = this.stream(context, params.stream, params.callId)
        const result = await this.boundary(served, sandboxOf(params.sandbox)).runShell({
          command: text(params.command, 'command'),
          cwd: await this.cwd(served, params.cwd),
          signal: context.signal,
          ...envOf(params.env),
          ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
          ...(params.maxBuffer !== undefined ? { maxBuffer: params.maxBuffer } : {}),
          ...(params.unsandboxed ? { unsandboxed: true } : {}),
          ...(onOutput ? { onOutput } : {}),
        })
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr } satisfies ProcessCallResult
      }
      case 'process/run': {
        const params = raw as ParamsOf<'process/run'>
        if (!Array.isArray(params.argv) || !params.argv.every(item => typeof item === 'string')) {
          throw new RpcError('argv must be a list of strings', RpcErrorCode.INVALID_PARAMS)
        }
        const served = await this.workspace(params.workspaceId)
        const onOutput = this.stream(context, params.stream, params.callId)
        return await this.boundary(served, sandboxOf(params.sandbox)).runProcess({
          argv: params.argv,
          cwd: await this.cwd(served, params.cwd),
          signal: context.signal,
          ...envOf(params.env),
          ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
          ...(params.maxBuffer !== undefined ? { maxBuffer: params.maxBuffer } : {}),
          ...(onOutput ? { onOutput } : {}),
        }) satisfies ProcessCallResult
      }
      case 'process/start':
        return await this.start(raw as StartParams)
      case 'process/kill': {
        const handle = param(raw, 'handle')
        const entry = typeof handle === 'string' ? this.background.get(handle) : undefined
        if (!entry) return null
        await entry.process.kill()
        return null
      }
      case 'http/fetch': {
        const params = raw as ParamsOf<'http/fetch'>
        return await this.execution.fetchHttp({
          url: text(params.url, 'url'),
          signal: context.signal,
          ...(params.headers ? { headers: params.headers } : {}),
          ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
          ...(params.allowPrivate ? { allowPrivate: true } : {}),
        })
      }
      case 'service/call': {
        const calls = this.exposed(param(raw, 'service')).calls
        const name = text(param(raw, 'method'), 'method')
        const call = Object.hasOwn(calls, name) ? calls[name] : undefined
        if (!call) throw new RpcError(`${String(param(raw, 'service'))} has no method ${name}`, RpcErrorCode.METHOD_NOT_FOUND)
        return (await call(argsOf(param(raw, 'args')))) ?? null
      }
      case 'stream/open': {
        const streams = this.exposed(param(raw, 'service')).streams ?? {}
        const name = text(param(raw, 'method'), 'method')
        const source = Object.hasOwn(streams, name) ? streams[name] : undefined
        if (!source) throw new RpcError(`${String(param(raw, 'service'))} has no stream ${name}`, RpcErrorCode.METHOD_NOT_FOUND)
        await this.streams.open(text(param(raw, 'stream'), 'stream'), source, argsOf(param(raw, 'args')))
        return null
      }
      case 'stream/resume': {
        const after = param(raw, 'after')
        return { replayed: this.streams.resume(text(param(raw, 'stream'), 'stream'), typeof after === 'number' ? after : 0) } satisfies ResultOf<'stream/resume'>
      }
      case 'stream/close': {
        this.streams.close(text(param(raw, 'stream'), 'stream'))
        return null
      }
      case 'initialize':
        throw new RpcError('the daemon sends initialize, it does not answer it', RpcErrorCode.INVALID_REQUEST)
      default:
        throw new RpcError(`unknown method ${String(method)}`, RpcErrorCode.METHOD_NOT_FOUND)
    }
  }

  private exposed(name: unknown): ExposedService {
    const services = this.options.services ?? {}
    const service = typeof name === 'string' && Object.hasOwn(services, name) ? services[name] : undefined
    if (!service) throw new RpcError(`this daemon does not serve ${String(name)}`, RpcErrorCode.METHOD_NOT_FOUND)
    return service
  }

  private async start(params: StartParams): Promise<ResultOf<'process/start'>> {
    const served = await this.workspace(params.workspaceId)
    const boundary = this.boundary(served, sandboxOf(params.sandbox))
    const cwd = await this.cwd(served, params.cwd)
    const env = envOf(params.env)
    let process: BackgroundProcess
    if (typeof params.command === 'string') {
      if (!boundary.startShell) throw new RpcError('this daemon cannot start background commands', RpcErrorCode.CALL_FAILED)
      process = await boundary.startShell({ command: params.command, cwd, ...env, ...(params.unsandboxed ? { unsandboxed: true } : {}) })
    } else if (Array.isArray(params.argv)) {
      if (!boundary.startProcess) throw new RpcError('this daemon cannot start background processes', RpcErrorCode.CALL_FAILED)
      process = await boundary.startProcess({ argv: params.argv, cwd, ...env })
    } else {
      throw new RpcError('process/start needs command or argv', RpcErrorCode.INVALID_PARAMS)
    }
    const handle = randomUUID()
    this.background.set(handle, { process, workspaceId: served.workspace.id })
    let last = ''
    const push = (): void => {
      const output = process.output()
      if (output === last) return
      last = output
      this.peer?.notify('process/tail', { handle, output })
    }
    const timer = setInterval(push, TAIL_INTERVAL_MS)
    timer.unref()
    void process.exited.then(exitCode => {
      clearInterval(timer)
      push()
      this.peer?.notify('process/exit', { handle, exitCode })
      this.background.delete(handle)
    })
    return {
      handle,
      ...(process.pid !== undefined ? { pid: process.pid } : {}),
      ...(process.sandboxed ? { sandboxed: true } : {}),
    }
  }
}

function isNetworkRequest(value: unknown): value is SandboxNetworkRequest {
  return value !== null && typeof value === 'object'
}

const MODES = new Set(['read-only', 'workspace-write', 'bypass'])

/** The sandbox a call asked for; anything unreadable is refused rather than run looser. */
function sandboxOf(value: unknown): SandboxParams | undefined {
  if (value === undefined) return undefined
  const mode = param(value, 'mode')
  if (typeof mode !== 'string' || !MODES.has(mode)) throw new RpcError('sandbox.mode must be read-only, workspace-write or bypass', RpcErrorCode.INVALID_PARAMS)
  const sessionId = param(value, 'sessionId')
  const network = param(value, 'network')
  return {
    mode: mode === 'bypass' ? 'bypass' : mode === 'workspace-write' ? 'workspace-write' : 'read-only',
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(network !== undefined ? { network } : {}),
  }
}

function envOf(value: unknown): { env?: Record<string, string> } {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object') throw new RpcError('env must be an object of strings', RpcErrorCode.INVALID_PARAMS)
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new RpcError(`env.${key} must be a string`, RpcErrorCode.INVALID_PARAMS)
    env[key] = item
  }
  return { env }
}

function writeMode(value: unknown): FsWriteMode {
  return value === 'create' || value === 'append' ? value : 'replace'
}

function param(raw: unknown, key: string): unknown {
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new RpcError(`${name} must be a string`, RpcErrorCode.INVALID_PARAMS)
  return value
}


function argsOf(value: unknown): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new RpcError('args must be an array', RpcErrorCode.INVALID_PARAMS)
  return value
}
