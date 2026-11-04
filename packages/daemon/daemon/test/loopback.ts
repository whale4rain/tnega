/**
 * Loopback helpers for the contract tests: an in-process daemon on a memory
 * transport, so every call is serialized to JSON and back exactly as it
 * would be over a socket.
 */
import { relative, isAbsolute } from 'node:path'
import type { Context } from '@tnega/core'
import { FsService, type FsRange, type FsWriteOptions, type WorkspaceFs } from '@tnega/fs'
import { acceptDaemon, memoryTransportPair, type DaemonLink } from '@tnega/daemon-protocol'
import { RemoteWorkspaceFs, announcedWorkspace } from '@tnega/fs-remote'
import { remoteExecutionProvider } from '@tnega/process-remote'
import type { ExecutionProvider } from '@tnega/process'
import { startDaemon, type Daemon } from '../src/index.js'

export interface Loopback {
  link: DaemonLink
  daemon: Daemon
  close(): Promise<void>
}

export async function loopbackDaemon(workspaces: readonly string[], execution?: ExecutionProvider): Promise<Loopback> {
  const [runtimeSide, daemonSide] = memoryTransportPair()
  const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
  const daemon = startDaemon({
    connect: () => daemonSide,
    workspaces: workspaces.map(path => ({ path })),
    reconnect: false,
    heartbeat: false,
    ...(execution ? { execution } : {}),
  })
  const link = await accepted
  await daemon.ready
  return {
    link,
    daemon,
    async close() {
      await daemon.close()
      link.close()
    },
  }
}

const opened: Loopback[] = []

/** Close every loopback a contract test opened; returns how many there were. */
export async function closeLoopbacks(): Promise<number> {
  const all = opened.splice(0)
  await Promise.all(all.map(item => item.close()))
  return all.length
}

/** A workspace whose daemon starts on first use, so `workspace()` can stay synchronous. */
class LazyRemoteFs implements WorkspaceFs {
  private readonly remote: Promise<RemoteWorkspaceFs>

  constructor(readonly root: string) {
    this.remote = loopbackDaemon([root]).then(loopback => {
      opened.push(loopback)
      return new RemoteWorkspaceFs(loopback.link, announcedWorkspace(loopback.link, root))
    })
  }

  async realRoot(): Promise<string> { return await (await this.remote).realRoot() }
  async resolve(path: string): Promise<string> { return await (await this.remote).resolve(path) }
  async stat(path: string) { return await (await this.remote).stat(path) }
  async readFile(path: string, range?: FsRange) { return await (await this.remote).readFile(path, range) }
  async writeFile(path: string, data: string | Uint8Array, options?: FsWriteOptions) { await (await this.remote).writeFile(path, data, options) }
  async list(path: string) { return await (await this.remote).list(path) }
  async mkdir(path: string) { await (await this.remote).mkdir(path) }
  async remove(path: string, options?: { recursive?: boolean }) { await (await this.remote).remove(path, options) }
  async rename(from: string, to: string) { await (await this.remote).rename(from, to) }
}

class LoopbackFs extends FsService {
  override workspace(root: string): WorkspaceFs {
    return new LazyRemoteFs(root)
  }
}

/** Stands in for `fsLocal`: the same plugin shape, files served through a loopback daemon. */
export const loopbackFsLocal = {
  name: 'fs-local',
  apply(ctx: Context): void {
    new LoopbackFs(ctx)
  },
}

/**
 * Stands in for `localExecutionProvider`: each call runs through a loopback
 * daemon for the folder it names (the real local boundary sits behind it),
 * with the sandbox off, as the raw boundary has none.
 */
export function loopbackExecution(local: ExecutionProvider): ExecutionProvider {
  const daemons = new Map<string, Promise<ExecutionProvider>>()
  const forCwd = async (cwd: string): Promise<ExecutionProvider> => {
    for (const [root, provider] of daemons) {
      const rel = relative(root, cwd)
      if (!rel.startsWith('..') && !isAbsolute(rel)) return await provider
    }
    const provider = loopbackDaemon([cwd], local).then(loopback => {
      opened.push(loopback)
      return remoteExecutionProvider(loopback.link, {
        workspaceId: loopback.daemon.workspaces[0]!.id,
        sandbox: () => ({ mode: 'bypass' }),
      })
    })
    daemons.set(cwd, provider)
    return await provider
  }
  return {
    runShell: async request => await (await forCwd(request.cwd)).runShell(request),
    runProcess: async request => await (await forCwd(request.cwd)).runProcess(request),
    fetchHttp: async request => await local.fetchHttp(request),
    startShell: async request => {
      const provider = await forCwd(request.cwd)
      return await provider.startShell!(request)
    },
    startProcess: async request => {
      const provider = await forCwd(request.cwd)
      return await provider.startProcess!(request)
    },
    ...(local.describeShell ? { describeShell: local.describeShell } : {}),
  }
}
