import { RpcError, RpcErrorCode, type Peer } from '@tnega/daemon-protocol'

/**
 * A Service Definition's methods as the daemon serves them. Each entry checks
 * its own arguments (they crossed a wire) and applies the workspace fence; the
 * daemon answers nothing that is not listed.
 */
export interface ExposedService {
  calls: Readonly<Record<string, (args: readonly unknown[]) => unknown>>
  /**
   * Methods that hand events to a listener. `emit` takes the next event; `end`
   * stops the stream from the source's side. Returns the unsubscribe.
   */
  streams?: Readonly<Record<string, (args: readonly unknown[], emit: (event: unknown) => void, end: (reason: string) => void) => (() => void) | Promise<() => void>>>
}

export interface StreamHubOptions {
  /** Events kept per stream for a resume. */
  bufferEvents?: number
  /** How long a stream waits for a resume after its connection drops. */
  graceMs?: number
}

interface OpenStream {
  seq: number
  buffer: Array<{ seq: number; event: unknown }>
  unsubscribe: (() => void) | undefined
  orphanTimer: NodeJS.Timeout | undefined
  ended: boolean
  /**
   * The connection that owned the stream dropped. Events are only buffered
   * until the stream's owner resumes it, so a replay is never overtaken by a
   * live event, and an end that happens meanwhile waits for the resume.
   */
  awaitingResume: boolean
  pendingEnd: string | undefined
}

/**
 * The daemon's open streams. Each event gets the next number and is kept in a
 * bounded buffer, so a runtime that reconnects can ask for what it missed. A
 * stream nobody resumes within the grace period is unsubscribed.
 */
export class StreamHub {
  private readonly streams = new Map<string, OpenStream>()
  private peer: Peer | undefined
  private readonly bufferEvents: number
  private readonly graceMs: number

  constructor(options: StreamHubOptions = {}) {
    this.bufferEvents = options.bufferEvents ?? 512
    this.graceMs = options.graceMs ?? 30_000
  }

  /** Send to this peer from now on; when it closes, every stream starts its grace period. */
  attach(peer: Peer): void {
    // A new connection is not yet the stream's owner coming back: only a resume stops the clock.
    this.peer = peer
    peer.onClose(() => {
      if (this.peer !== peer) return
      this.peer = undefined
      for (const [id, stream] of this.streams) this.orphan(id, stream)
    })
  }

  async open(id: string, source: NonNullable<ExposedService['streams']>[string], args: readonly unknown[]): Promise<void> {
    if (this.streams.has(id)) throw new RpcError(`stream ${id} is already open`, RpcErrorCode.INVALID_PARAMS)
    const stream: OpenStream = { seq: 0, buffer: [], unsubscribe: undefined, orphanTimer: undefined, ended: false, awaitingResume: false, pendingEnd: undefined }
    this.streams.set(id, stream)
    const emit = (event: unknown): void => {
      if (stream.ended || stream.pendingEnd !== undefined) return
      stream.seq += 1
      stream.buffer.push({ seq: stream.seq, event })
      if (stream.buffer.length > this.bufferEvents) stream.buffer.shift()
      if (!stream.awaitingResume) this.peer?.notify('stream/event', { stream: id, seq: stream.seq, event })
    }
    const end = (reason: string): void => {
      if (stream.ended || stream.pendingEnd !== undefined) return
      if (stream.awaitingResume) {
        // Keep the stream (and its buffer) until the resume or the grace period.
        stream.pendingEnd = reason
        this.unsubscribe(stream)
        return
      }
      this.peer?.notify('stream/end', { stream: id, reason })
      this.drop(id)
    }
    try {
      const unsubscribe = await source(args, emit, end)
      if (stream.ended || stream.pendingEnd !== undefined) unsubscribe()
      else stream.unsubscribe = unsubscribe
    } catch (error) {
      this.drop(id)
      throw error
    }
  }

  /** Re-send what came after `after`; fails with `STREAM_LOST` when that is no longer held. */
  resume(id: string, after: number): number {
    const stream = this.streams.get(id)
    if (!stream) throw new RpcError(`stream ${id} is gone`, RpcErrorCode.STREAM_LOST)
    const first = stream.buffer[0]?.seq ?? stream.seq + 1
    if (after < first - 1) throw new RpcError(`stream ${id} lost events after ${after}`, RpcErrorCode.STREAM_LOST)
    this.clearOrphan(stream)
    const missed = stream.buffer.filter(item => item.seq > after)
    for (const item of missed) this.peer?.notify('stream/event', { stream: id, seq: item.seq, event: item.event })
    stream.awaitingResume = false
    if (stream.pendingEnd !== undefined) {
      this.peer?.notify('stream/end', { stream: id, reason: stream.pendingEnd })
      this.drop(id)
    }
    return missed.length
  }

  close(id: string): void {
    this.drop(id)
  }

  get size(): number {
    return this.streams.size
  }

  dispose(): void {
    for (const id of [...this.streams.keys()]) this.drop(id)
  }

  private orphan(id: string, stream: OpenStream): void {
    this.clearOrphan(stream)
    stream.awaitingResume = true
    stream.orphanTimer = setTimeout(() => this.drop(id), this.graceMs)
    stream.orphanTimer.unref()
  }

  private clearOrphan(stream: OpenStream): void {
    if (stream.orphanTimer) clearTimeout(stream.orphanTimer)
    stream.orphanTimer = undefined
  }

  private drop(id: string): void {
    const stream = this.streams.get(id)
    if (!stream) return
    this.streams.delete(id)
    stream.ended = true
    this.clearOrphan(stream)
    this.unsubscribe(stream)
  }

  private unsubscribe(stream: OpenStream): void {
    const unsubscribe = stream.unsubscribe
    stream.unsubscribe = undefined
    try { unsubscribe?.() } catch { /* the source is going away anyway */ }
  }
}
