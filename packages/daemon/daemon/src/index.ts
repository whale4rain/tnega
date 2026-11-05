import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import {
  Peer,
  PROTOCOL_VERSION,
  RemoteError,
  RpcErrorCode,
  initialize,
  type DaemonCapabilities,
  type DaemonWorkspace,
  type InitializeResult,
  type PeerOptions,
  type Transport,
} from '@tnega/daemon-protocol'
import type { ExecutionProvider } from '@tnega/process'
import { describeShell, systemShell } from '@tnega/process-local'
import { TerminalManager, type TerminalLocalConfig } from '@tnega/terminal-local'
import { DaemonService } from './serve.js'
import type { ExposedService, StreamHubOptions } from './services.js'
import { exposeTerminals } from './terminals.js'

export { DaemonService, type ServeOptions } from './serve.js'
export { StreamHub, type ExposedService, type StreamHubOptions } from './services.js'
export { exposeTerminals } from './terminals.js'
export { assertSecureServerUrl, connectWebSocket, type WebSocketTransportOptions } from './websocket.js'

export interface DaemonWorkspaceInput {
  path: string
  /** Defaults to a stable id derived from the path. */
  id?: string
}

export type DaemonState = 'connecting' | 'ready' | 'reconnecting' | 'stopped'

export interface StartDaemonOptions {
  /** Open a fresh connection; called again for every reconnect. */
  connect: () => Transport | Promise<Transport>
  workspaces: readonly DaemonWorkspaceInput[]
  deviceId?: string
  /** Reconnect after a dropped connection, with exponential backoff. Default on. */
  reconnect?: false | { minDelayMs?: number; maxDelayMs?: number }
  heartbeat?: PeerOptions['heartbeat']
  /** The undecorated boundary; defaults to this machine (see `ServeOptions.execution`). */
  execution?: ExecutionProvider
  /**
   * The person's terminals in these workspaces (`ctx.terminals` over the
   * protocol). On by default; `false` serves none. Tests pass a fake PTY.
   */
  terminals?: TerminalLocalConfig | false
  streams?: StreamHubOptions
  /** The protocol version sent in `initialize`; only tests change it. */
  protocolVersion?: number
  onState?: (state: DaemonState, detail?: string) => void
}

export interface Daemon {
  readonly deviceId: string
  readonly workspaces: readonly DaemonWorkspace[]
  /** Resolves on the first accepted handshake; rejects if the runtime refuses it. */
  readonly ready: Promise<InitializeResult>
  readonly state: DaemonState
  /**
   * Stop: no more reconnects, cancel in-flight calls, kill the background
   * processes this daemon started, close the connection.
   */
  close(): Promise<void>
}

/** A workspace id that stays the same for one path on one machine. */
export function workspaceId(path: string): string {
  return `ws_${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 16)}`
}

export function daemonCapabilities(services: readonly string[] = []): DaemonCapabilities {
  return {
    fs: true,
    process: true,
    http: true,
    shell: describeShell(systemShell()),
    platform: process.platform,
    ...(services.length ? { services: [...services] } : {}),
  }
}

/**
 * Run a daemon: dial the runtime, announce the workspaces, serve `fs/*`,
 * `process/*` and `http/*` from this machine's Providers until closed.
 * A dropped connection is dialled again with backoff; a refused handshake
 * (wrong version, unknown device) stops the daemon.
 */
export function startDaemon(options: StartDaemonOptions): Daemon {
  const workspaces: DaemonWorkspace[] = options.workspaces.map(item => ({
    id: item.id ?? workspaceId(item.path),
    path: resolve(item.path),
  }))
  const deviceId = options.deviceId ?? `dev_${createHash('sha256').update(hostname()).digest('hex').slice(0, 12)}`
  const services: Record<string, ExposedService> = {}
  const terminals = options.terminals === false ? undefined : new TerminalManager(options.terminals ?? {})
  if (terminals) services.terminals = exposeTerminals(terminals, workspaces)
  const service = new DaemonService({
    workspaces,
    services,
    ...(options.execution ? { execution: options.execution } : {}),
    ...(options.streams ? { streams: options.streams } : {}),
    onClose: () => terminals?.dispose(),
  })
  const minDelay = options.reconnect === false ? 0 : options.reconnect?.minDelayMs ?? 500
  const maxDelay = options.reconnect === false ? 0 : options.reconnect?.maxDelayMs ?? 30_000
  let state: DaemonState = 'connecting'
  let stopping = false
  let peer: Peer | undefined
  let retry: NodeJS.Timeout | undefined
  let wake: (() => void) | undefined
  let markReady: (result: InitializeResult) => void = () => {}
  let markFailed: (error: Error) => void = () => {}
  let first = true
  const ready = new Promise<InitializeResult>((resolveReady, rejectReady) => {
    markReady = resolveReady
    markFailed = rejectReady
  })
  // A caller that only closes must not see an unhandled rejection.
  ready.catch(() => undefined)

  const setState = (next: DaemonState, detail?: string): void => {
    state = next
    options.onState?.(next, detail)
  }

  const pause = (ms: number): Promise<void> => new Promise(done => {
    wake = done
    retry = setTimeout(done, ms)
  })

  const session = async (): Promise<'closed' | 'refused'> => {
    const transport = await options.connect()
    const current = new Peer(transport, {
      ...(options.heartbeat !== undefined ? { heartbeat: options.heartbeat } : {}),
      handle: (method, params, context) => service.handle(method, params, context),
    })
    peer = current
    service.attach(current)
    const closed = new Promise<void>(done => current.onClose(() => done()))
    try {
      const result = await initialize(current, {
        protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
        deviceId,
        capabilities: daemonCapabilities(service.services),
        workspaces,
      })
      setState('ready')
      if (first) {
        first = false
        markReady(result)
      }
    } catch (error) {
      if (error instanceof RemoteError && error.rpcCode !== RpcErrorCode.CONNECTION_LOST) {
        current.close('refused')
        if (first) markFailed(error)
        return 'refused'
      }
      throw error
    }
    await closed
    return 'closed'
  }

  void (async () => {
    let delay = minDelay
    while (!stopping) {
      try {
        const outcome = await session()
        if (outcome === 'refused') break
        delay = minDelay
      } catch (error) {
        if (options.reconnect === false && first) markFailed(error instanceof Error ? error : new Error(String(error)))
      }
      if (stopping || options.reconnect === false) break
      setState('reconnecting')
      await pause(delay)
      delay = Math.min(maxDelay, Math.max(minDelay, delay * 2))
    }
    if (!stopping) {
      setState('stopped')
      await service.close()
    }
  })()

  return {
    deviceId,
    workspaces,
    ready,
    get state() { return state },
    async close() {
      if (stopping) return
      stopping = true
      if (retry) clearTimeout(retry)
      wake?.()
      peer?.close('daemon stopped')
      await service.close()
      if (first) markFailed(new Error('daemon stopped before it connected'))
      setState('stopped')
    },
  }
}

export const name = '@tnega/daemon'
