import type { Context } from '@tnega/core'
import { RemoteError, forwardService, type DaemonLink, type ServiceForwarder } from '@tnega/daemon-protocol'
import {
  TerminalError,
  TerminalService,
  isTerminalEvent,
  isTerminalInfo,
  type TerminalEvent,
  type TerminalInfo,
  type TerminalSize,
} from '@tnega/terminal'

/** A remote failure as the local one, so the routes answer with the same status. */
function local(error: unknown): unknown {
  if (error instanceof RemoteError && error.name === 'TerminalError') return new TerminalError(error.message, error.status ?? 500)
  return error
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw local(error)
  }
}

function info(value: unknown): TerminalInfo {
  if (!isTerminalInfo(value)) throw new TerminalError('the daemon sent a malformed terminal', 502)
  return value
}

/** `ctx.terminals` on a daemon: every method is one forwarded call, `attach` is a stream. */
export class RemoteTerminals extends TerminalService {
  private readonly remote: ServiceForwarder

  constructor(ctx: Context, link: DaemonLink) {
    super(ctx)
    if (!link.capabilities.services?.includes('terminals')) {
      throw new TerminalError('this daemon does not serve terminals', 501)
    }
    this.remote = forwardService(link, 'terminals')
  }

  async list(workspace?: string): Promise<TerminalInfo[]> {
    const list = await guarded(() => this.remote.call('list', workspace === undefined ? [] : [workspace]))
    return Array.isArray(list) ? list.map(info) : []
  }

  async create(workspace: string, size: TerminalSize = {}): Promise<TerminalInfo> {
    return info(await guarded(() => this.remote.call('create', [workspace, size])))
  }

  async attach(id: string, listener: (event: TerminalEvent) => void, onEnd?: (reason: string) => void): Promise<() => void> {
    const stream = await guarded(() => this.remote.stream('attach', [id], {
      onEvent: event => { if (isTerminalEvent(event)) listener(event) },
      ...(onEnd ? { onEnd } : {}),
    }))
    return () => { void stream.close() }
  }

  async write(id: string, data: string): Promise<void> {
    await guarded(() => this.remote.call('write', [id, data]))
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await guarded(() => this.remote.call('resize', [id, cols, rows]))
  }

  async close(id: string): Promise<void> {
    await guarded(() => this.remote.call('close', [id]))
  }
}

/** Provide `ctx.terminals` from a daemon. */
export const terminalRemote = {
  name: 'terminal-remote',
  apply(ctx: Context, config: { link: DaemonLink }): void {
    new RemoteTerminals(ctx, config.link)
  },
}

export const name = '@tnega/terminal-remote'
