import { posix, win32 } from 'node:path'
import type { Context } from '@tnega/core'
import {
  FsError,
  FsService,
  type FsEntry,
  type FsRange,
  type FsStat,
  type FsWriteOptions,
  type WorkspaceFs,
} from '@tnega/fs'
import { RemoteError, decodeBytes, encodeBytes, type DaemonLink, type DaemonWorkspace } from '@tnega/daemon-protocol'

/** A `FsError` from the daemon comes back as one, so callers handle it as they would locally. */
function local(error: unknown): unknown {
  if (error instanceof RemoteError && error.name === 'FsError' && (error.code === 'FS_EXISTS' || error.code === 'FS_BUSY')) {
    return new FsError(error.message, error.code)
  }
  return error
}

async function rethrow<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw local(error)
  }
}

/**
 * One workspace on a daemon. Every call names the workspace id the daemon
 * announced, and the daemon fences it; paths are in the daemon's own form.
 */
export class RemoteWorkspaceFs implements WorkspaceFs {
  private real: Promise<string> | undefined

  constructor(private readonly link: DaemonLink, private readonly workspace: DaemonWorkspace) {}

  get root(): string {
    return this.workspace.path
  }

  private get id(): string {
    return this.workspace.id
  }

  async realRoot(): Promise<string> {
    this.real ??= this.link.call('fs/realRoot', { workspaceId: this.id })
    return await this.real
  }

  async resolve(path: string): Promise<string> {
    return await rethrow(() => this.link.call('fs/resolve', { workspaceId: this.id, path }))
  }

  async stat(path: string): Promise<FsStat | undefined> {
    return await rethrow(async () => await this.link.call('fs/stat', { workspaceId: this.id, path }) ?? undefined)
  }

  async readFile(path: string, range?: FsRange): Promise<Uint8Array> {
    const data = await rethrow(() => this.link.call('fs/read', { workspaceId: this.id, path, ...(range ? { start: range.start, end: range.end } : {}) }))
    return decodeBytes(data)
  }

  async writeFile(path: string, data: string | Uint8Array, options: FsWriteOptions = {}): Promise<void> {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    await rethrow(() => this.link.call('fs/write', {
      workspaceId: this.id,
      path,
      data: encodeBytes(bytes),
      ...(options.mode ? { mode: options.mode } : {}),
    }, options.signal ? { signal: options.signal } : {}))
  }

  async list(path: string): Promise<FsEntry[]> {
    return await rethrow(() => this.link.call('fs/list', { workspaceId: this.id, path }))
  }

  async mkdir(path: string): Promise<void> {
    await rethrow(() => this.link.call('fs/mkdir', { workspaceId: this.id, path }))
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await rethrow(() => this.link.call('fs/remove', { workspaceId: this.id, path, ...(options.recursive ? { recursive: true } : {}) }))
  }

  async rename(from: string, to: string): Promise<void> {
    await rethrow(() => this.link.call('fs/rename', { workspaceId: this.id, from, to }))
  }
}

/**
 * Find the announced workspace for a root path, or refuse. The path is
 * compared by the daemon's rules, not this machine's: a Windows daemon's
 * `C:\\Repo` and `c:/repo/` are the same folder.
 */
export function announcedWorkspace(link: DaemonLink, root: string): DaemonWorkspace {
  const windows = link.capabilities.platform === 'win32'
  const key = (path: string): string => windows ? win32.resolve(path).toLowerCase() : posix.resolve(path)
  const wanted = key(root)
  const found = link.workspaces.find(item => item.path === root || key(item.path) === wanted)
  if (!found) throw new RemoteError(`daemon ${link.deviceId} does not serve ${root}`, -32002, { name: 'WorkspaceDeniedError', code: 'WORKSPACE_DENIED' })
  return found
}

/**
 * The remote Provider of `ctx.fs`: files on a daemon. A workspace the daemon
 * did not announce is refused when it is opened. `allowOutside` (the
 * `bypass` permission) is not offered remotely: the daemon always fences.
 */
export class RemoteFs extends FsService {
  constructor(ctx: Context, private readonly link: DaemonLink) {
    super(ctx)
  }

  override workspace(root: string): WorkspaceFs {
    return new RemoteWorkspaceFs(this.link, announcedWorkspace(this.link, root))
  }
}

/** Mount: `await ctx.plugin(fsRemote, { link })`. The composition layer picks it. */
export const fsRemote = {
  name: 'fs-remote',
  apply(ctx: Context, config: { link: DaemonLink }): void {
    new RemoteFs(ctx, config.link)
  },
}

export const name = '@tnega/fs-remote'
