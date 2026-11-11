import { WebSocket } from 'undici'
import { TransportBase, type Transport } from '@tnega/daemon-protocol'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Check a server URL before anything is sent to it: `wss://` (TLS with a
 * validated certificate), or `ws://` to this machine for development. The
 * token never goes over plain text to another host.
 */
export function assertSecureServerUrl(raw: string, options: { allowPlain?: boolean } = {}): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`not a server URL: ${raw}`)
  }
  if (url.protocol === 'wss:') return url
  if (url.protocol === 'ws:' && (LOCAL_HOSTS.has(url.hostname) || options.allowPlain)) return url
  throw new Error(`refusing ${url.protocol}//${url.host}: a daemon connects only over wss:// (or ws://localhost for development)`)
}

class WebSocketTransport extends TransportBase implements Transport {
  constructor(private readonly socket: WebSocket) {
    super()
    socket.addEventListener('message', event => {
      const data: unknown = event.data
      if (typeof data === 'string') this.deliver(data)
      else if (data instanceof ArrayBuffer) this.deliver(Buffer.from(data).toString('utf8'))
    })
    socket.addEventListener('close', event => this.markClosed(event.reason || `closed (${event.code})`))
    socket.addEventListener('error', () => this.markClosed('socket error'))
  }

  send(message: string): void {
    if (this.closed) throw new Error('transport is closed')
    this.socket.send(message)
  }

  close(reason?: string): void {
    if (!this.markClosed(reason)) return
    try {
      this.socket.close(1000, reason?.slice(0, 120))
    } catch {
      // Already closing.
    }
  }
}

export interface WebSocketTransportOptions {
  /** Device token, sent as a bearer header on the upgrade request. */
  token?: string
  /** Give up on the connection after this long. */
  connectTimeoutMs?: number
  /**
   * Allow `ws://` to a host other than localhost. Only for a link that never
   * leaves the machine, such as a box dialling the server on its own host.
   */
  allowPlain?: boolean
}

/** Dial a runtime over WebSocket. Resolves once the socket is open. */
export async function connectWebSocket(serverUrl: string, options: WebSocketTransportOptions = {}): Promise<Transport> {
  const url = assertSecureServerUrl(serverUrl, { allowPlain: options.allowPlain === true })
  const socket = new WebSocket(url, {
    ...(options.token ? { headers: { authorization: `Bearer ${options.token}` } } : {}),
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`could not reach ${url.host} in time`))
    }, options.connectTimeoutMs ?? 15_000)
    timer.unref()
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`could not connect to ${url.host}`)) }, { once: true })
  })
  return new WebSocketTransport(socket)
}
