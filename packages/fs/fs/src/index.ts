import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface ServiceMap {
    fs: FsService
  }
}

/** What a path names, after symlinks are followed. */
export type FsKind = 'file' | 'dir' | 'symlink' | 'other'

export interface FsStat {
  kind: FsKind
  size: number
  mtimeMs: number
  /** Permission bits (`mode & 0o7777`); 0 where the platform has none. */
  mode: number
}

/** One entry of a directory listing. `kind` is the entry's own type: a symlink stays `symlink`. */
export interface FsEntry {
  name: string
  kind: FsKind
}

/**
 * How a write lands.
 *
 * - `replace` (default): atomic publish; a reader sees the old content or the
 *   new one, never half. An existing file keeps its permission bits.
 * - `create`: atomic and never overwrites; a file that appears first fails
 *   with {@link FsError} `FS_EXISTS`.
 * - `append`: add to the end; creates the file when it is missing.
 *
 * Parent directories are created as needed in every mode.
 */
export type FsWriteMode = 'replace' | 'create' | 'append'

export interface FsWriteOptions {
  mode?: FsWriteMode
  signal?: AbortSignal
}

/** A byte range, `end` exclusive. */
export interface FsRange {
  start: number
  end: number
}

/** A switch read per call: fixed, or decided when the call runs (a permission can change mid-session). */
export type FsSwitch = boolean | (() => boolean | Promise<boolean>)

export interface WorkspaceFsOptions {
  /**
   * Let paths leave the workspace (the `bypass` permission). Off by default:
   * every path is fenced inside the workspace, symlinks included.
   */
  allowOutside?: FsSwitch
}

/**
 * Stable codes for what the file system refused in a way a caller handles.
 * Anything else (a missing file, a permission error) keeps the platform's own
 * error and its `code` (`ENOENT`, `EACCES` …).
 *
 * - `FS_EXISTS`: a `create` write found the file already there.
 * - `FS_BUSY`: another program holds the target open and the replace gave up;
 *   the old content is intact.
 */
export type FsErrorCode = 'FS_EXISTS' | 'FS_BUSY'

export class FsError extends Error {
  override name = 'FsError'

  constructor(message: string, readonly code: FsErrorCode, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * One workspace as a file system. Every method takes a path relative to the
 * workspace root, or an absolute path, and the Provider fences each call:
 * a path that leaves the workspace (by `..`, an absolute name or a symlink)
 * is refused unless {@link WorkspaceFsOptions.allowOutside} is on.
 *
 * Absolute paths are in the Provider's own form (`node:path` on the machine
 * that holds the files). A Consumer gets them back from {@link resolve} and
 * hands them in again; it never builds one from scratch.
 */
export interface WorkspaceFs {
  /** The workspace root as it was named. */
  readonly root: string
  /** The workspace root with every symlink followed. */
  realRoot(): Promise<string>
  /**
   * The name a path really has: symlinks followed, also for a path that does
   * not exist yet or a link whose target is missing, then fenced again. Locks,
   * read records and writes all use this one name.
   */
  resolve(path: string): Promise<string>
  /** Follows symlinks. `undefined` when nothing is there. */
  stat(path: string): Promise<FsStat | undefined>
  /** The whole file, or the bytes of `range` (shorter at the end of the file). */
  readFile(path: string, range?: FsRange): Promise<Uint8Array>
  writeFile(path: string, data: string | Uint8Array, options?: FsWriteOptions): Promise<void>
  /** The entries of one directory, in the order the platform returns them. */
  list(path: string): Promise<FsEntry[]>
  /** Create a directory and its parents; no error when it exists. */
  mkdir(path: string): Promise<void>
  /** Remove a file, or a directory with `recursive`; no error when it is missing. */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
}

/**
 * The file system seam's Service Definition: owns `ctx.fs`.
 *
 * A scope's file access goes through here so the files can live on another
 * machine: the local Provider (`@tnega/fs-local`) uses `node:fs`, a remote
 * Provider sends the same calls to a daemon. Consumers (`@tnega/tool-fs`,
 * `@tnega/tool-send-file`, `@tnega/workspace-files`) import only this package.
 *
 * One Provider per scope; a second one in the same scope fails at mount, as
 * with every Service.
 */
export abstract class FsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /** The file system of one workspace. Cheap: callers may open one per request. */
  abstract workspace(root: string, options?: WorkspaceFsOptions): WorkspaceFs
}

export async function switchOn(value: FsSwitch | undefined): Promise<boolean> {
  if (value === undefined) return false
  return typeof value === 'function' ? await value() : value
}

/** Whether an error is the platform's "nothing there" (`ENOENT` / `ENOTDIR`). */
export function isMissingError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}

export default FsService

export const name = '@tnega/fs'
