/**
 * A message pipe between two peers. Messages are JSON text; the transport
 * neither parses nor reorders them. `close` is idempotent and every close,
 * either side's, reaches both `onClose` listeners once.
 */
export interface Transport {
  send(message: string): void
  onMessage(listener: (message: string) => void): () => void
  onClose(listener: (reason?: string) => void): () => void
  close(reason?: string): void
  readonly closed: boolean
}

/** Shared bookkeeping for transports: listeners and a once-only close. */
export class TransportBase {
  private readonly messageListeners = new Set<(message: string) => void>()
  private readonly closeListeners = new Set<(reason?: string) => void>()
  private isClosed = false

  get closed(): boolean {
    return this.isClosed
  }

  onMessage(listener: (message: string) => void): () => void {
    this.messageListeners.add(listener)
    return () => { this.messageListeners.delete(listener) }
  }

  onClose(listener: (reason?: string) => void): () => void {
    if (this.isClosed) {
      queueMicrotask(() => listener())
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  protected deliver(message: string): void {
    if (this.isClosed) return
    for (const listener of [...this.messageListeners]) listener(message)
  }

  /** Mark closed and tell the listeners; returns false when already closed. */
  protected markClosed(reason?: string): boolean {
    if (this.isClosed) return false
    this.isClosed = true
    const listeners = [...this.closeListeners]
    this.closeListeners.clear()
    this.messageListeners.clear()
    for (const listener of listeners) listener(reason)
    return true
  }
}

class MemoryTransport extends TransportBase implements Transport {
  other: MemoryTransport | undefined

  send(message: string): void {
    if (this.closed) throw new Error('transport is closed')
    const other = this.other
    // Asynchronous like a socket, and in order.
    queueMicrotask(() => other?.deliver(message))
  }

  close(reason?: string): void {
    if (!this.markClosed(reason)) return
    const other = this.other
    queueMicrotask(() => other?.close(reason))
  }

  /** Make deliver callable from the paired side. */
  override deliver(message: string): void {
    super.deliver(message)
  }
}

/**
 * Two connected in-process transports. Every message is a JSON string, so
 * a loopback exercises the same serialization as a socket: local mode and
 * the contract tests use it.
 */
export function memoryTransportPair(): [Transport, Transport] {
  const left = new MemoryTransport()
  const right = new MemoryTransport()
  left.other = right
  right.other = left
  return [left, right]
}
