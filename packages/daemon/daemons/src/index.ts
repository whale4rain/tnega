import { Service, type Context } from '@tnega/core'
import type { DaemonLink } from '@tnega/daemon-protocol'

declare module '@tnega/core' {
  interface ServiceMap {
    daemons: DaemonRegistry
  }
}

/**
 * `ctx.daemons`: the daemons connected to this runtime right now, by the
 * device id the server gave them (not the id a daemon says it has). Whoever
 * accepts a connection (the WebSocket gateway on a server) adds it; whoever
 * needs a machine (a run that works in a box) looks it up or waits for it.
 *
 * One live link per device: a new connection replaces the old one, which is
 * closed, so a daemon that reconnects after a network drop takes over at once.
 * A link leaves the registry when it closes.
 */
export interface ConnectedDaemon {
  /** The server's device id (`device` row), the registry's key. */
  deviceId: string
  /** The account the device belongs to. */
  accountId: string
  link: DaemonLink
  connectedAt: string
}

export class DaemonWaitTimeout extends Error {
  override name = 'DaemonWaitTimeout'
  readonly code = 'DAEMON_TIMEOUT'
}

export class DaemonRegistry extends Service {
  private readonly live = new Map<string, ConnectedDaemon>()
  private readonly waiters = new Map<string, Set<(daemon: ConnectedDaemon) => void>>()
  private readonly listeners = new Set<(event: 'connected' | 'disconnected', daemon: ConnectedDaemon) => void>()

  constructor(ctx: Context) {
    super(ctx, 'daemons')
    ctx.fiber.effect(() => () => {
      for (const daemon of [...this.live.values()]) daemon.link.close('runtime stopped')
      this.live.clear()
    }, 'daemons/close links')
  }

  /** Add a connected daemon; an older link for the same device is closed. */
  add(input: Omit<ConnectedDaemon, 'connectedAt'>): ConnectedDaemon {
    const daemon: ConnectedDaemon = { ...input, connectedAt: new Date().toISOString() }
    const previous = this.live.get(daemon.deviceId)
    this.live.set(daemon.deviceId, daemon)
    if (previous && previous.link !== daemon.link) previous.link.close('replaced by a new connection')
    daemon.link.onClose(() => {
      if (this.live.get(daemon.deviceId) !== daemon) return
      this.live.delete(daemon.deviceId)
      this.emit('disconnected', daemon)
    })
    const waiting = this.waiters.get(daemon.deviceId)
    this.waiters.delete(daemon.deviceId)
    for (const resolve of waiting ?? []) resolve(daemon)
    this.emit('connected', daemon)
    return daemon
  }

  get(deviceId: string): ConnectedDaemon | undefined {
    const daemon = this.live.get(deviceId)
    return daemon && !daemon.link.closed ? daemon : undefined
  }

  list(): ConnectedDaemon[] {
    return [...this.live.values()].filter(daemon => !daemon.link.closed)
  }

  /** The device's link once it connects; rejects with {@link DaemonWaitTimeout} after `timeoutMs`. */
  wait(deviceId: string, timeoutMs: number, signal?: AbortSignal): Promise<ConnectedDaemon> {
    const now = this.get(deviceId)
    if (now) return Promise.resolve(now)
    return new Promise((resolve, reject) => {
      const set = this.waiters.get(deviceId) ?? new Set<(daemon: ConnectedDaemon) => void>()
      this.waiters.set(deviceId, set)
      const done = (daemon: ConnectedDaemon): void => { cleanup(); resolve(daemon) }
      const cleanup = (): void => {
        clearTimeout(timer)
        set.delete(done)
        if (!set.size && this.waiters.get(deviceId) === set) this.waiters.delete(deviceId)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => { cleanup(); reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted')) }
      const timer = setTimeout(() => {
        cleanup()
        reject(new DaemonWaitTimeout(`device ${deviceId} did not connect within ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      set.add(done)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Close the device's link, if it has one (a revoked token, a stopped box). */
  disconnect(deviceId: string, reason: string): void {
    this.live.get(deviceId)?.link.close(reason)
  }

  on(listener: (event: 'connected' | 'disconnected', daemon: ConnectedDaemon) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: 'connected' | 'disconnected', daemon: ConnectedDaemon): void {
    for (const listener of [...this.listeners]) listener(event, daemon)
  }
}

/** Plugin: provide `ctx.daemons`. */
export const daemons = {
  name: 'daemons',
  apply(ctx: Context): void {
    new DaemonRegistry(ctx)
  },
}

export const name = '@tnega/daemons'
