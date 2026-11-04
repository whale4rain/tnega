import {
  MUTATING_METHODS,
  PROTOCOL_VERSION,
  RpcErrorCode,
  isSupportedVersion,
  type DaemonCapabilities,
  type DaemonMethod,
  type DaemonWorkspace,
  type InitializeParams,
  type InitializeResult,
  type ParamsOf,
  type ResultOf,
} from './methods.js'
import { Peer, RpcError, type PeerOptions, type RequestOptions } from './peer.js'
import type { Transport } from './transport.js'

/**
 * The runtime's view of one connected daemon, after a handshake it accepted.
 * Remote Providers (`fs-remote`, `process-remote`) send their calls through it.
 */
export interface DaemonLink {
  readonly deviceId: string
  readonly protocolVersion: number
  readonly capabilities: DaemonCapabilities
  readonly workspaces: readonly DaemonWorkspace[]
  readonly closed: boolean
  /** Typed request. Mutating methods get a fresh `callId` unless one is given. */
  call<M extends DaemonMethod>(method: M, params: ParamsOf<M>, options?: RequestOptions): Promise<ResultOf<M>>
  onNotification(method: string, listener: (params: unknown) => void): () => void
  onClose(listener: (reason?: string) => void): () => void
  close(reason?: string): void
}

export interface AcceptOptions extends Omit<PeerOptions, 'handle'> {
  /** Longest wait for `initialize` before the connection is dropped. */
  handshakeTimeoutMs?: number
  /** Reject a daemon by its handshake (unknown device, workspace not allowed …). */
  admit?: (params: InitializeParams) => void | Promise<void>
}

function validWorkspaces(value: unknown): value is DaemonWorkspace[] {
  return Array.isArray(value) && value.every(item => item !== null && typeof item === 'object'
    && typeof (item as DaemonWorkspace).id === 'string' && typeof (item as DaemonWorkspace).path === 'string')
}

/**
 * Accept one daemon on a transport: wait for its `initialize`, refuse a
 * version outside N and N-1, then answer with ours. Resolves once the daemon
 * is ready to serve calls.
 */
export function acceptDaemon(transport: Transport, options: AcceptOptions = {}): Promise<DaemonLink> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error('daemon did not initialize in time'))
      transport.close('handshake timeout')
    }, options.handshakeTimeoutMs ?? 10_000)
    timer.unref()
    const peer: Peer = new Peer(transport, {
      ...(options.heartbeat !== undefined ? { heartbeat: options.heartbeat } : {}),
      handle: async (method, params) => {
        if (method !== 'initialize') {
          throw new RpcError(`${method} before initialize`, RpcErrorCode.NOT_INITIALIZED)
        }
        if (settled) throw new RpcError('already initialized', RpcErrorCode.INVALID_REQUEST)
        const init = params as Partial<InitializeParams> | undefined
        if (!isSupportedVersion(init?.protocolVersion)) {
          const error = new RpcError(`protocol version ${String(init?.protocolVersion)} is not supported (this runtime speaks ${PROTOCOL_VERSION - 1} and ${PROTOCOL_VERSION})`, RpcErrorCode.VERSION_REFUSED)
          fail(error)
          // Answer first, then hang up.
          setTimeout(() => transport.close('version refused'), 0)
          throw error
        }
        if (typeof init?.deviceId !== 'string' || !validWorkspaces(init.workspaces)) {
          const error = new RpcError('initialize needs a deviceId and workspaces', RpcErrorCode.INVALID_PARAMS)
          fail(error)
          setTimeout(() => transport.close('bad handshake'), 0)
          throw error
        }
        const accepted: InitializeParams = {
          protocolVersion: init.protocolVersion,
          deviceId: init.deviceId,
          capabilities: init.capabilities ?? {},
          workspaces: init.workspaces,
        }
        try {
          await options.admit?.(accepted)
        } catch (error) {
          const refused = new RpcError(error instanceof Error ? error.message : String(error), RpcErrorCode.WORKSPACE_DENIED)
          fail(refused)
          setTimeout(() => transport.close('refused'), 0)
          throw refused
        }
        settled = true
        clearTimeout(timer)
        const result: InitializeResult = { protocolVersion: accepted.protocolVersion, serverTime: new Date().toISOString() }
        queueMicrotask(() => resolve(linkFor(peer, accepted)))
        return result
      },
    })
    peer.onClose(reason => fail(new Error(`daemon closed before initialize${reason ? `: ${reason}` : ''}`)))
  })
}

function linkFor(peer: Peer, init: InitializeParams): DaemonLink {
  return {
    deviceId: init.deviceId,
    protocolVersion: init.protocolVersion,
    capabilities: init.capabilities,
    workspaces: init.workspaces,
    get closed() { return peer.closed },
    async call(method, params, options) {
      const withId = MUTATING_METHODS.has(method) && !(params as { callId?: string }).callId
        ? { ...params, callId: crypto.randomUUID() }
        : params
      return await peer.request(method, withId, options) as ResultOf<typeof method>
    },
    onNotification: (method, listener) => peer.onNotification(method, listener),
    onClose: listener => peer.onClose(listener),
    close: reason => peer.close(reason),
  }
}

/**
 * The daemon's side of the handshake: send `initialize` on a fresh peer and
 * wait for the runtime's answer.
 */
export async function initialize(peer: Peer, params: Omit<InitializeParams, 'protocolVersion'> & { protocolVersion?: number }): Promise<InitializeResult> {
  return await peer.request('initialize', { protocolVersion: PROTOCOL_VERSION, ...params }) as InitializeResult
}
