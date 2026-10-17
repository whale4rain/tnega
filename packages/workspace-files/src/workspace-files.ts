import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { DEFAULT_SEARCH_EXCLUDES } from '@tnega/search'
import { resolveInside } from '@tnega/tools'
import { FileServeError } from './files.js'

/**
 * The Files panel: browse the workspace one directory at a time, open text files
 * and save edits. Every path goes through `resolveInside`, so the panel cannot
 * reach outside the workspace, symlinks included.
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

async function inside(workspace: string, path: string): Promise<string> {
  try {
    return await resolveInside(workspace, path || '.')
  } catch (error) {
    throw new FileServeError(error instanceof Error ? error.message : String(error), 400)
  }
}

function relativePath(workspace: string, target: string): string {
  return relative(workspace, target).replaceAll('\\', '/')
}

export async function listDirectory(workspace: string, path = ''): Promise<DirectoryEntry[]> {
  const target = await inside(workspace, path)
  const entries = await readdir(target, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new FileServeError(`directory not found: ${path || '.'}`, 404)
    throw error
  })
  const listed: DirectoryEntry[] = []
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue
    const isDir = entry.isDirectory()
    if (!isDir && !entry.isFile() && !entry.isSymbolicLink()) continue
    const childPath = relativePath(workspace, `${target}/${entry.name}`)
    if (isDir) {
      listed.push({ name: entry.name, path: childPath, type: 'dir' })
    } else {
      const info = await stat(`${target}/${entry.name}`).catch(() => undefined)
      if (!info) continue
      listed.push(info.isDirectory()
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

export async function readTextFile(workspace: string, path: string): Promise<TextFile> {
  const target = await inside(workspace, path)
  const info = await stat(target).catch(() => undefined)
  if (!info?.isFile()) throw new FileServeError(`file not found: ${path}`, 404)
  const base = { path: relativePath(workspace, target), size: info.size, mtimeMs: info.mtimeMs }
  if (info.size > MAX_TEXT_FILE_BYTES) return { ...base, reason: 'too-large' }
  const bytes = await readFile(target)
  if (looksBinary(bytes)) return { ...base, reason: 'binary' }
  return { ...base, content: bytes.toString('utf8') }
}

/**
 * Save an edit. `expectedMtimeMs` is the version the editor loaded; if the file
 * changed since (the agent edited it, say), the save is refused with 409 rather
 * than silently overwriting that change.
 */
export async function writeTextFile(
  workspace: string,
  path: string,
  content: string,
  expectedMtimeMs?: number,
): Promise<TextFile> {
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) {
    throw new FileServeError(`file exceeds ${MAX_TEXT_FILE_BYTES} bytes`, 413)
  }
  const target = await inside(workspace, path)
  const info = await stat(target).catch(() => undefined)
  if (info && !info.isFile()) throw new FileServeError(`not a file: ${path}`, 400)
  if (expectedMtimeMs !== undefined && info && Math.abs(info.mtimeMs - expectedMtimeMs) > 1) {
    throw new FileServeError(`${path} changed on disk since it was opened`, 409)
  }
  await writeFile(target, content, 'utf8')
  const saved = await stat(target)
  return { path: relativePath(workspace, target), content, size: saved.size, mtimeMs: saved.mtimeMs }
}
