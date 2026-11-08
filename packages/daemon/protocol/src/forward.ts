import { randomUUID } from 'node:crypto'
import type { DaemonLink } from './link.js'
import type { RequestOptions } from './peer.js'
import type { StreamEndNotification, StreamEventNotification } from './methods.js'

/**
 * The runtime side of a service the daemon exposes: any Service Definition's
 * methods forwarded one to one, so a remote Provider is a thin adapter that
 * checks what comes back. Methods that hand a listener back become streams.
 */
export interface ServiceForwarder {
  /** Call one of the service's methods on the daemon; `signal` cancels it there too. */
  call(method: string, args: unknown[], options?: RequestOptions): Promise<unknown>
  /** Open one of the service's streaming methods; events arrive in order, once each. */
  stream(method: string, args: unknown[], handlers: StreamHandlers): Promise<RemoteStream>
}

export interface StreamHandlers {
  onEvent(event: unknown): void
  /** The stream stopped without being closed here: its source ended or the connection went away. */
  onEnd?(reason: string): void
}

export interface RemoteStream {
  readonly id: string
  /** The last event seen; pass it to `resumeStream` on a new connection to get the rest. */
  readonly lastSeq: number
  /** Stop following and let the daemon drop the stream. */
  close(): Promise<void>
}

function isEvent(value: unknown): value is StreamEventNotification {
  return value !== null && typeof value === 'object'
    && typeof (value as StreamEventNotification).stream === 'string' && typeof (value as StreamEventNotification).seq === 'number'
}

function isEnd(value: unknown): value is StreamEndNotification {
  return value !== null && typeof value === 'object' && typeof (value as StreamEndNotification).stream === 'string'
}

/** Follow stream `id` on `link`: skip anything at or before `after`, stop on end or close. */
function follow(link: DaemonLink, id: string, after: number, handlers: StreamHandlers): RemoteStream & { stop(): void } {
  let lastSeq = after
  let done = false
  const stop = (): void => {
    if (done) return
    done = true
    offEvent()
    offEnd()
    offClose()
  }
  const end = (reason: string): void => {
    if (done) return
    stop()
    try { handlers.onEnd?.(reason) } catch { /* an observer must not break the link */ }
  }
  const offEvent = link.onNotification('stream/event', params => {
    if (done || !isEvent(params) || params.stream !== id || params.seq <= lastSeq) return
    lastSeq = params.seq
    try { handlers.onEvent(params.event) } catch { /* as above */ }
  })
  const offEnd = link.onNotification('stream/end', params => {
    if (isEnd(params) && params.stream === id) end(typeof params.reason === 'string' ? params.reason : 'ended')
  })
  const offClose = link.onClose(reason => end(`connection lost${reason ? `: ${reason}` : ''}`))
  return {
    id,
    get lastSeq() { return lastSeq },
    stop,
    async close() {
      if (done) return
      stop()
      await link.call('stream/close', { stream: id }).catch(() => undefined)
    },
  }
}

export function forwardService(link: DaemonLink, service: string): ServiceForwarder {
  return {
    async call(method, args, options) {
      return await link.call('service/call', { service, method, args }, options)
    },
    async stream(method, args, handlers) {
      // The id is chosen here so no early event (a replayed scrollback) can arrive before we listen.
      const id = randomUUID()
      const followed = follow(link, id, 0, handlers)
      try {
        await link.call('stream/open', { service, method, args, stream: id })
      } catch (error) {
        followed.stop()
        throw error
      }
      return followed
    },
  }
}

/**
 * Pick a stream up again on a new connection to the same daemon. The daemon
 * replays what came after `after`; a stream it no longer holds fails with
 * `STREAM_LOST`, and the caller opens a fresh one.
 */
export async function resumeStream(link: DaemonLink, id: string, after: number, handlers: StreamHandlers): Promise<RemoteStream> {
  const followed = follow(link, id, after, handlers)
  try {
    await link.call('stream/resume', { stream: id, after })
  } catch (error) {
    followed.stop()
    throw error
  }
  return followed
}
