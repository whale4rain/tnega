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
  private readonly base: string

  /**
   * `root` may be a folder inside the announced workspace (a Project thread's
   * worktree in its box): relative paths start there, and the daemon still
   * fences the whole workspace.
   */
  constructor(private readonly link: DaemonLink, private readonly workspace: DaemonWorkspace, root?: string) {
    this.base = root ?? workspace.path
  }

  get root(): string {
    return this.base
  }

  /** A path as the daemon reads it: relative paths against this root, in the daemon's own form. */
  private at(path: string): string {
    if (this.base === this.workspace.path) return path
    const paths = this.link.capabilities.platform === 'win32' ? win32 : posix
    return paths.isAbsolute(path) ? path : paths.join(this.base, path)
  }

  private get id(): string {
    return this.workspace.id
  }

  async realRoot(): Promise<string> {
    this.real ??= this.base === this.workspace.path
      ? this.link.call('fs/realRoot', { workspaceId: this.id })
      : rethrow(() => this.link.call('fs/resolve', { workspaceId: this.id, path: this.base }))
    return await this.real
  }

  async resolve(path: string): Promise<string> {
    return await rethrow(() => this.link.call('fs/resolve', { workspaceId: this.id, path: this.at(path) }))
  }

  async stat(path: string): Promise<FsStat | undefined> {
    return await rethrow(async () => await this.link.call('fs/stat', { workspaceId: this.id, path: this.at(path) }) ?? undefined)
  }

  async readFile(path: string, range?: FsRange): Promise<Uint8Array> {
    const data = await rethrow(() => this.link.call('fs/read', { workspaceId: this.id, path: this.at(path), ...(range ? { start: range.start, end: range.end } : {}) }))
    return decodeBytes(data)
  }

  async writeFile(path: string, data: string | Uint8Array, options: FsWriteOptions = {}): Promise<void> {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    await rethrow(() => this.link.call('fs/write', {
      workspaceId: this.id,
      path: this.at(path),
      data: encodeBytes(bytes),
      ...(options.mode ? { mode: options.mode } : {}),
    }, options.signal ? { signal: options.signal } : {}))
  }

  async list(path: string): Promise<FsEntry[]> {
    return await rethrow(() => this.link.call('fs/list', { workspaceId: this.id, path: this.at(path) }))
  }

  async mkdir(path: string): Promise<void> {
    await rethrow(() => this.link.call('fs/mkdir', { workspaceId: this.id, path: this.at(path) }))
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await rethrow(() => this.link.call('fs/remove', { workspaceId: this.id, path: this.at(path), ...(options.recursive ? { recursive: true } : {}) }))
  }

  async rename(from: string, to: string): Promise<void> {
    await rethrow(() => this.link.call('fs/rename', { workspaceId: this.id, from: this.at(from), to: this.at(to) }))
  }
}

/**
 * Find the announced workspace for a root path, or refuse. The path is
 * compared by the daemon's rules, not this machine's: a Windows daemon's
 * `C:\\Repo` and `c:/repo/` are the same folder.
 */
export function announcedWorkspace(link: DaemonLink, root: string): DaemonWorkspace {
  const windows = link.capabilities.platform === 'win32'
  // Normalised, not resolved: resolving would read a relative root against this process's folder.
  const key = (path: string): string => windows
    ? win32.normalize(path).replace(/[\\/]+$/u, '').toLowerCase()
    : posix.normalize(path).replace(/\/+$/u, '')
  const wanted = key(root)
  const separator = windows ? '\\' : '/'
  // The folder itself, or a folder inside it (a Project thread's worktree in its box).
  const found = link.workspaces.find(item => item.path === root || key(item.path) === wanted)
    ?? link.workspaces.find(item => {
      const base = key(item.path)
      return wanted.startsWith(base.endsWith(separator) ? base : `${base}${separator}`)
    })
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
    const announced = announcedWorkspace(this.link, root)
    return new RemoteWorkspaceFs(this.link, announced, root === announced.path ? undefined : root)
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
