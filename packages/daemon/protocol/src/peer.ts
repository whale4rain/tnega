import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  RemoteError,
  RpcErrorCode,
  type RpcErrorData,
} from './methods.js'
import type { Transport } from './transport.js'

interface RequestMessage { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
interface NotificationMessage { jsonrpc: '2.0'; method: string; params?: unknown }
interface ResponseMessage {
  jsonrpc: '2.0'
  id: number | null
  result?: unknown
  error?: { code: number; message: string; data?: RpcErrorData }
}

export interface HandlerContext {
  /** Aborted when the caller sends `$/cancel` or the connection closes. */
  signal: AbortSignal
  /** The request id, for tagging notifications that belong to this call. */
  id: number
}

export type RequestHandler = (method: string, params: unknown, context: HandlerContext) => Promise<unknown>

export interface RequestOptions {
  signal?: AbortSignal
}

export interface PeerOptions {
  /** Answers incoming requests. A peer with none answers METHOD_NOT_FOUND. */
  handle?: RequestHandler
  /** Send heartbeats and drop a silent connection. Defaults to on. */
  heartbeat?: false | { intervalMs?: number; timeoutMs?: number }
}

function errorData(error: unknown): RpcErrorData {
  if (!(error instanceof Error)) return {}
  const code = (error as { code?: unknown }).code
  return { name: error.name, ...(typeof code === 'string' ? { code } : {}) }
}

/** An error thrown on purpose by a handler, with its own protocol code. */
export class RpcError extends Error {
  constructor(message: string, readonly rpcCode: number, readonly data: RpcErrorData = {}) {
    super(message)
    this.name = data.name ?? 'RpcError'
  }
}

function toResponseError(error: unknown): NonNullable<ResponseMessage['error']> {
  if (error instanceof RpcError) return { code: error.rpcCode, message: error.message, data: error.data }
  if (error instanceof RemoteError) {
    return { code: error.rpcCode, message: error.message, data: { name: error.name, ...(error.code ? { code: error.code } : {}) } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: RpcErrorCode.CALL_FAILED, message, data: errorData(error) }
}

/**
 * One end of a JSON-RPC 2.0 connection. Both sides are peers: either may send
 * requests and notifications. The peer owns its transport: closing either
 * fails every pending request with `CONNECTION_LOST` and aborts every running
 * handler, so nothing outlives the connection.
 */
export class Peer {
  private nextId = 1
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>()
  private readonly running = new Map<number, AbortController>()
  private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>()
  private readonly closeListeners = new Set<(reason?: string) => void>()
  private heartbeatTimer: NodeJS.Timeout | undefined
  private lastHeard = Date.now()
  private closeReason: string | undefined

  constructor(private readonly transport: Transport, private readonly options: PeerOptions = {}) {
    transport.onMessage(message => this.receive(message))
    transport.onClose(reason => this.shutdown(reason))
    if (options.heartbeat !== false) this.startHeartbeat(options.heartbeat ?? {})
  }

  get closed(): boolean {
    return this.transport.closed
  }

  /** Called once when the connection ends, whichever side ended it. */
  onClose(listener: (reason?: string) => void): () => void {
    if (this.transport.closed) {
      queueMicrotask(() => listener(this.closeReason))
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  onNotification(method: string, listener: (params: unknown) => void): () => void {
    let listeners = this.notificationListeners.get(method)
    if (!listeners) {
      listeners = new Set()
      this.notificationListeners.set(method, listeners)
    }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  request(method: string, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.transport.closed) return Promise.reject(this.lostError())
    options.signal?.throwIfAborted()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        this.safeSend({ jsonrpc: '2.0', method: '$/cancel', params: { id } })
        reject(new RemoteError(`${method} cancelled`, RpcErrorCode.REQUEST_CANCELLED, { name: 'AbortError' }))
      }
      const cleanup = (): void => options.signal?.removeEventListener('abort', onAbort)
      this.pending.set(id, {
        resolve: value => { cleanup(); resolve(value) },
        reject: error => { cleanup(); reject(error) },
        cleanup,
      })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        this.pending.delete(id)
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.transport.closed) return
    this.safeSend({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  close(reason?: string): void {
    this.transport.close(reason)
  }

  private lostError(): RemoteError {
    return new RemoteError(`connection lost${this.closeReason ? `: ${this.closeReason}` : ''}`, RpcErrorCode.CONNECTION_LOST, { name: 'ConnectionLostError' })
  }

  private send(message: RequestMessage | NotificationMessage | ResponseMessage): void {
    const text = JSON.stringify(message)
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
      throw new RemoteError(`message exceeds the protocol limit of ${MAX_MESSAGE_BYTES} bytes`, RpcErrorCode.INVALID_PARAMS)
    }
    this.transport.send(text)
  }

  private safeSend(message: RequestMessage | NotificationMessage | ResponseMessage): void {
    try {
      this.send(message)
    } catch {
      // The connection is going away; its close handler settles the rest.
    }
  }

  private startHeartbeat(options: { intervalMs?: number; timeoutMs?: number }): void {
    const interval = options.intervalMs ?? HEARTBEAT_INTERVAL_MS
    const timeout = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > timeout) {
        this.transport.close('heartbeat lost')
        return
      }
      this.notify('$/heartbeat', {})
    }, interval)
    this.heartbeatTimer.unref()
  }

  private receive(text: string): void {
    this.lastHeard = Date.now()
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
      this.safeSend({ jsonrpc: '2.0', id: null, error: { code: RpcErrorCode.INVALID_REQUEST, message: 'message too large' } })
      return
    }
    let message: Partial<RequestMessage & ResponseMessage>
    try {
      message = JSON.parse(text) as Partial<RequestMessage & ResponseMessage>
    } catch {
      this.safeSend({ jsonrpc: '2.0', id: null, error: { code: RpcErrorCode.PARSE_ERROR, message: 'invalid JSON' } })
      return
    }
    if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') return
    if (typeof message.method === 'string') {
      if (typeof message.id === 'number') void this.answer(message.id, message.method, message.params)
      else this.notified(message.method, message.params)
      return
    }
    if (typeof message.id === 'number') this.settle(message.id, message)
  }

  private notified(method: string, params: unknown): void {
    if (method === '$/cancel') {
      const id = (params as { id?: unknown } | undefined)?.id
      if (typeof id === 'number') this.running.get(id)?.abort()
      return
    }
    for (const listener of [...this.notificationListeners.get(method) ?? []]) {
      try {
        listener(params)
      } catch {
        // A listener's failure is its own; the connection carries on.
      }
    }
  }

  private settle(id: number, message: Partial<ResponseMessage>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (message.error) pending.reject(new RemoteError(message.error.message, message.error.code, message.error.data ?? {}))
    else pending.resolve(message.result ?? null)
  }

  private async answer(id: number, method: string, params: unknown): Promise<void> {
    const handle = this.options.handle
    if (!handle) {
      this.safeSend({ jsonrpc: '2.0', id, error: { code: RpcErrorCode.METHOD_NOT_FOUND, message: `no handler for ${method}` } })
      return
    }
    const controller = new AbortController()
    this.running.set(id, controller)
    try {
      const result = await handle(method, params, { signal: controller.signal, id })
      if (!this.transport.closed) this.safeSend({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (error) {
      if (controller.signal.aborted && this.transport.closed) return
      const response = controller.signal.aborted
        ? { code: RpcErrorCode.REQUEST_CANCELLED, message: `${method} cancelled`, data: { name: 'AbortError' } }
        : toResponseError(error)
      this.safeSend({ jsonrpc: '2.0', id, error: response })
    } finally {
      this.running.delete(id)
    }
  }

  private shutdown(reason?: string): void {
    this.closeReason = reason
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    const lost = this.lostError()
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(lost)
    }
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
    this.notificationListeners.clear()
    const listeners = [...this.closeListeners]
    this.closeListeners.clear()
    for (const listener of listeners) listener(reason)
  }
}
