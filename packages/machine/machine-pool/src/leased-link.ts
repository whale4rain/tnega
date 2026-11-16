import type { DaemonCapabilities, DaemonLink, DaemonMethod, DaemonWorkspace, ParamsOf, RequestOptions, ResultOf } from '@tnega/daemon-protocol'
import type { MachineLease } from './index.js'

export interface LeasedLinkOptions {
  /** A lease on the box: started or resumed, its daemon connected. */
  acquire: () => Promise<MachineLease>
  /**
   * Let go of the lease this long after the last call ends and the last
   * background process or stream on the box is over, so the pool can pause
   * the box while the agent waits. The next call takes a new lease, which
   * resumes it. Default 60 s.
   */
  idleMs?: number
}

type Listener = (params: unknown) => void

function streamKey(params: unknown): string {
  const stream: unknown = typeof params === 'object' && params !== null ? Reflect.get(params, 'stream') : undefined
  return `stream:${String(stream)}`
}

/**
 * A daemon link for a scope that outlives its box's leases: a Project
 * thread's agent stays loaded while its box pauses and resumes. Every call
 * runs on the box's current link, taking a lease first when none is held (a
 * paused box resumes, and a box that came back with a new daemon connection
 * is used through that one). Notification listeners follow the link; close
 * listeners hear each underlying link close, so a stream on a paused box
 * ends instead of hanging. A background process (`process/start`) or an
 * open stream (`stream/open`) keeps the lease until it ends: pausing the box
 * would freeze it and cut its output. `close` lets go for good.
 */
export class LeasedLink implements DaemonLink {
  private lease: MachineLease | undefined
  private last: DaemonLink
  private acquiring: Promise<MachineLease> | undefined
  private inflight = 0
  private timer: NodeJS.Timeout | undefined
  private done = false
  private readonly notifications = new Map<string, Set<Listener>>()
  private readonly closeListeners = new Set<(reason?: string) => void>()
  private detach: Array<() => void> = []
  /** Background processes and streams under way on the box: each holds the lease. */
  private readonly holds = new Set<string>()
  /** Processes that ended before their `process/start` answer arrived. */
  private readonly endedEarly = new Set<string>()

  private constructor(private readonly options: LeasedLinkOptions, lease: MachineLease) {
    this.last = lease.link
    this.attach(lease)
    this.releaseLater()
  }

  /** Take the first lease (the box starts), so the link knows its daemon's capabilities. */
  static async open(options: LeasedLinkOptions): Promise<LeasedLink> {
    return new LeasedLink(options, await options.acquire())
  }

  get deviceId(): string { return this.last.deviceId }
  get protocolVersion(): number { return this.last.protocolVersion }
  get capabilities(): DaemonCapabilities { return this.last.capabilities }
  get workspaces(): readonly DaemonWorkspace[] { return this.last.workspaces }
  get closed(): boolean { return this.done }
  /** Whether a lease is held now: false once the box may pause. */
  get leased(): boolean { return this.lease !== undefined }

  async call<M extends DaemonMethod>(method: M, params: ParamsOf<M>, options?: RequestOptions): Promise<ResultOf<M>> {
    if (this.done) throw new Error('the box link is closed')
    this.inflight += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    try {
      const link = await this.current()
      if (method === 'stream/open') this.hold(streamKey(params))
      try {
        const result = await link.call(method, params, options)
        this.track(method, params, result)
        return result
      } catch (error) {
        if (method === 'stream/open') this.holds.delete(streamKey(params))
        throw error
      }
    } finally {
      this.inflight -= 1
      this.releaseLater()
    }
  }

  onNotification(method: string, listener: Listener): () => void {
    let listeners = this.notifications.get(method)
    if (!listeners) {
      listeners = new Set()
      this.notifications.set(method, listeners)
      this.detach.push(this.last.onNotification(method, params => this.notify(method, params)))
    }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  onClose(listener: (reason?: string) => void): () => void {
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  close(reason?: string): void {
    if (this.done) return
    this.done = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const stop of this.detach.splice(0)) stop()
    this.lease?.release()
    this.lease = undefined
    for (const listener of [...this.closeListeners]) listener(reason)
  }

  /** Whether a background process or stream is holding the lease. */
  get holding(): number { return this.holds.size }

  private hold(key: string): void {
    this.holds.add(key)
  }

  private track(method: string, params: unknown, result: unknown): void {
    if (method === 'process/start') {
      const handle: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'handle') : undefined
      if (typeof handle !== 'string') return
      if (this.endedEarly.delete(handle)) return
      this.hold(`process:${handle}`)
    } else if (method === 'stream/close') {
      this.holds.delete(streamKey(params))
    }
  }

  /** A process or stream ended: it no longer holds the lease. */
  private ended(method: string, params: unknown): void {
    if (typeof params !== 'object' || params === null) return
    if (method === 'process/exit') {
      const handle: unknown = Reflect.get(params, 'handle')
      if (typeof handle !== 'string') return
      if (!this.holds.delete(`process:${handle}`) && this.inflight > 0) {
        this.endedEarly.add(handle)
        if (this.endedEarly.size > 100) this.endedEarly.delete(this.endedEarly.values().next().value ?? '')
      }
    } else {
      this.holds.delete(streamKey(params))
    }
    this.releaseLater()
  }

  private notify(method: string, params: unknown): void {
    for (const listener of [...this.notifications.get(method) ?? []]) listener(params)
  }

  private async current(): Promise<DaemonLink> {
    const held = this.lease
    if (held && !held.link.closed) return held.link
    if (held) this.drop(held)
    this.acquiring ??= this.options.acquire().then(lease => {
      if (this.done) {
        lease.release()
        throw new Error('the box link is closed')
      }
      this.attach(lease)
      return lease
    }).finally(() => { this.acquiring = undefined })
    return (await this.acquiring).link
  }

  private attach(lease: MachineLease): void {
    const fresh = lease.link !== this.last || this.detach.length === 0
    if (fresh) {
      // A new daemon connection: move the listeners onto it.
      for (const stop of this.detach.splice(0)) stop()
      this.last = lease.link
      for (const method of this.notifications.keys()) {
        this.detach.push(lease.link.onNotification(method, params => this.notify(method, params)))
      }
      for (const method of ['process/exit', 'stream/end']) {
        this.detach.push(lease.link.onNotification(method, params => this.ended(method, params)))
      }
    }
    this.lease = lease
    const link = lease.link
    this.detach.push(link.onClose(reason => {
      // What ran on that connection is out of reach now.
      this.holds.clear()
      this.endedEarly.clear()
      if (this.lease === lease) this.drop(lease)
      if (!this.done) for (const listener of [...this.closeListeners]) listener(reason)
    }))
  }

  private drop(lease: MachineLease): void {
    lease.release()
    if (this.lease === lease) this.lease = undefined
  }

  private releaseLater(): void {
    if (this.done || this.inflight > 0 || this.holds.size > 0) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.inflight > 0 || this.holds.size > 0 || !this.lease) return
      this.drop(this.lease)
    }, this.options.idleMs ?? 60_000)
    this.timer.unref()
  }
}
