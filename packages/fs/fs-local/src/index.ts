import { appendFile, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@tnega/core'
import {
  FsService,
  isMissingError,
  switchOn,
  type FsEntry,
  type FsKind,
  type FsRange,
  type FsStat,
  type FsSwitch,
  type FsWriteOptions,
  type WorkspaceFs,
  type WorkspaceFsOptions,
} from '@tnega/fs'
import { resolveInside } from '@tnega/fs-sandbox'
import { writeFileAtomic } from './atomic.js'
import { canonicalPath } from './canonical.js'

export { writeFileAtomic } from './atomic.js'
export { canonicalPath } from './canonical.js'

function kindOf(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FsKind {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'dir'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'other'
}

/**
 * One workspace on this machine, through `node:fs`.
 *
 * Every call is fenced by `@tnega/fs-sandbox` (the one definition of "inside
 * the workspace") unless `allowOutside` is on. Writes follow symlinks first
 * and fence the followed name again, so a link never carries a write out.
 */
export class LocalWorkspaceFs implements WorkspaceFs {
  private readonly allowOutside: FsSwitch
  private real: Promise<string> | undefined

  constructor(readonly root: string, options: WorkspaceFsOptions = {}) {
    this.allowOutside = options.allowOutside ?? false
  }

  async realRoot(): Promise<string> {
    this.real ??= realpath(this.root).catch(() => this.root)
    return await this.real
  }

  /** The lexical target of a path: fenced, symlinks not followed. */
  private async fence(path: string): Promise<string> {
    const input = path === '' ? '.' : path
    return await switchOn(this.allowOutside) ? resolve(this.root, input) : await resolveInside(this.root, input)
  }

  async resolve(path: string): Promise<string> {
    const target = await canonicalPath(await this.fence(path))
    // The followed name is fenced again: a link swapped after the first check
    // must not carry the write outside the workspace.
    return await switchOn(this.allowOutside) ? target : await resolveInside(await this.realRoot(), target)
  }

  async stat(path: string): Promise<FsStat | undefined> {
    const target = await this.fence(path)
    try {
      const info = await stat(target)
      return { kind: kindOf(info), size: info.size, mtimeMs: info.mtimeMs, mode: info.mode & 0o7777 }
    } catch (error) {
      if (isMissingError(error)) return undefined
      throw error
    }
  }

  async readFile(path: string, range?: FsRange): Promise<Uint8Array> {
    const target = await this.fence(path)
    if (!range) return await readFile(target)
    const length = Math.max(0, range.end - range.start)
    const handle = await open(target, 'r')
    try {
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, range.start)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  async writeFile(path: string, data: string | Uint8Array, options: FsWriteOptions = {}): Promise<void> {
    const target = await this.resolve(path)
    const signal = options.signal ? { signal: options.signal } : {}
    switch (options.mode ?? 'replace') {
      case 'append':
        options.signal?.throwIfAborted()
        await mkdir(dirname(target), { recursive: true })
        await appendFile(target, data, { ...typeof data === 'string' ? { encoding: 'utf8' as const } : {}, ...signal })
        return
      case 'create':
        await writeFileAtomic(target, data, { createOnly: true, ...signal })
        return
      case 'replace':
        await writeFileAtomic(target, data, signal)
    }
  }

  async list(path: string): Promise<FsEntry[]> {
    const target = await this.fence(path)
    const entries = await readdir(target, { withFileTypes: true })
    return entries.map(entry => ({ name: entry.name, kind: kindOf(entry) }))
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(await this.fence(path), { recursive: true })
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await rm(await this.fence(path), { force: true, recursive: options.recursive ?? false })
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(await this.fence(from), await this.fence(to))
  }
}

/** The local Provider of `ctx.fs`: workspaces on this machine. */
export class LocalFs extends FsService {
  override workspace(root: string, options?: WorkspaceFsOptions): WorkspaceFs {
    return new LocalWorkspaceFs(root, options)
  }
}

/**
 * Mount: `await ctx.plugin(fsLocal)`. The composition layer picks it; a
 * Consumer never imports this package.
 */
export const fsLocal = {
  name: 'fs-local',
  apply(ctx: Context): void {
    new LocalFs(ctx)
  },
}

export const name = '@tnega/fs-local'
