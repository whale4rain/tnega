import { relative, resolve } from 'node:path'
import { FsError, isMissingError, type WorkspaceFs } from '@tnega/fs'
import { DEFAULT_SEARCH_EXCLUDES } from '@tnega/search'
import { FileServeError } from './files.js'

/**
 * The Files panel: browse the workspace one directory at a time, open text files
 * and save edits. Every path goes through the workspace's `ctx.fs` handle,
 * which fences it, so the panel cannot reach outside the workspace, symlinks
 * included.
 */

export interface DirectoryEntry {
  name: string
  /** Workspace-relative, `/`-separated. */
  path: string
  type: 'dir' | 'file'
  size?: number
}

export interface TextFile {
  path: string
  /** Absent for binary or oversized files, which the panel does not open. */
  content?: string
  reason?: 'binary' | 'too-large'
  size: number
  mtimeMs: number
}

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 2000
const HIDDEN = new Set(DEFAULT_SEARCH_EXCLUDES)

/** The fence's refusal as a 400; a path error is the caller's, not the server's. */
export async function fenced<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Error && error.name === 'PathSandboxError') throw new FileServeError(error.message, 400)
    throw error
  }
}

/** The workspace-relative, `/`-separated form of a path as it was named (symlinks not followed). */
export function workspacePath(fs: WorkspaceFs, path: string): string {
  return relative(fs.root, resolve(fs.root, path || '.')).replaceAll('\\', '/')
}

/** Refuse a path outside the workspace with a 400 before anything reads it. */
export async function checkInside(fs: WorkspaceFs, path: string): Promise<void> {
  await fenced(() => fs.resolve(path || '.'))
}

/** Where a workspace-relative path lands, joined with `/` (the seam accepts it on every platform). */
function child(path: string, name: string): string {
  return path && path !== '.' ? `${path.replace(/\/+$/, '')}/${name}` : name
}

export async function listDirectory(fs: WorkspaceFs, path = ''): Promise<DirectoryEntry[]> {
  const entries = await fenced(() => fs.list(path)).catch((error: unknown) => {
    if (isMissingError(error)) throw new FileServeError(`directory not found: ${path || '.'}`, 404)
    throw error
  })
  const listed: DirectoryEntry[] = []
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue
    if (entry.kind === 'other') continue
    const childPath = workspacePath(fs, child(path, entry.name))
    if (entry.kind === 'dir') {
      listed.push({ name: entry.name, path: childPath, type: 'dir' })
    } else {
      const info = await fs.stat(child(path, entry.name)).catch(() => undefined)
      if (!info) continue
      listed.push(info.kind === 'dir'
        ? { name: entry.name, path: childPath, type: 'dir' }
        : { name: entry.name, path: childPath, type: 'file', size: info.size })
    }
  }
  listed.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1)
  return listed.slice(0, MAX_DIRECTORY_ENTRIES)
}

/** NUL bytes in the first 8 KiB mean binary, as git decides. */
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0)
}

export async function readTextFile(fs: WorkspaceFs, path: string): Promise<TextFile> {
  await checkInside(fs, path)
  const info = await fs.stat(path).catch(() => undefined)
  if (info?.kind !== 'file') throw new FileServeError(`file not found: ${path}`, 404)
  const base = { path: workspacePath(fs, path), size: info.size, mtimeMs: info.mtimeMs }
  if (info.size > MAX_TEXT_FILE_BYTES) return { ...base, reason: 'too-large' }
  const bytes = Buffer.from(await fs.readFile(path))
  if (looksBinary(bytes)) return { ...base, reason: 'binary' }
  return { ...base, content: bytes.toString('utf8') }
}

/**
 * Save an edit. `expectedMtimeMs` is the version the editor loaded; if the file
 * changed since (the agent edited it, say), the save is refused with 409 rather
 * than silently overwriting that change.
 */
export async function writeTextFile(
  fs: WorkspaceFs,
  path: string,
  content: string,
  expectedMtimeMs?: number,
): Promise<TextFile> {
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) {
    throw new FileServeError(`file exceeds ${MAX_TEXT_FILE_BYTES} bytes`, 413)
  }
  await checkInside(fs, path)
  const info = await fs.stat(path).catch(() => undefined)
  if (info && info.kind !== 'file') throw new FileServeError(`not a file: ${path}`, 400)
  if (expectedMtimeMs !== undefined && info && Math.abs(info.mtimeMs - expectedMtimeMs) > 1) {
    throw new FileServeError(`${path} changed on disk since it was opened`, 409)
  }
  try {
    await fs.writeFile(path, content)
  } catch (error) {
    if (error instanceof FsError && error.code === 'FS_BUSY') throw new FileServeError(error.message, 409)
    throw error
  }
  const saved = await fs.stat(path)
  if (!saved) throw new FileServeError(`file not found: ${path}`, 404)
  return { path: workspacePath(fs, path), content, size: saved.size, mtimeMs: saved.mtimeMs }
}
