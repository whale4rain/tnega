import { mkdir, open } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { resolveInside } from '@tnega/tools'
import { FileServeError } from './files.js'

/**
 * Files a person drops onto the message box. They are saved inside the
 * workspace so the agent reads them with its ordinary tools, and the message
 * names their paths. Saving never overwrites: a second `notes.md` becomes
 * `notes (2).md`.
 */

/** Workspace-relative folder dropped files land in. */
export const UPLOADS_DIR = '.tnega/uploads'
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_NAME_LENGTH = 120

/**
 * A dropped file's name made safe to save on any platform: no folders, no
 * characters Windows refuses, no leading dots, and never empty.
 */
export function safeUploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[<>:"|?*]/g, '_')
    .split('')
    .filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  if (!cleaned) return 'file'
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned
  const extension = extname(cleaned).slice(0, 16)
  return `${cleaned.slice(0, MAX_NAME_LENGTH - extension.length)}${extension}`
}

function numbered(name: string, index: number): string {
  if (index === 1) return name
  const extension = extname(name)
  const stem = extension ? name.slice(0, -extension.length) : name
  return `${stem} (${index})${extension}`
}

export interface SavedUpload {
  /** Workspace-relative, `/`-separated. */
  path: string
  size: number
}

export async function saveUpload(workspace: string, name: string, bytes: Uint8Array): Promise<SavedUpload> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new FileServeError(`file exceeds ${MAX_UPLOAD_BYTES} bytes`, 413)
  const safe = safeUploadName(name)
  let folder: string
  try {
    folder = await resolveInside(workspace, UPLOADS_DIR)
  } catch (error) {
    throw new FileServeError(error instanceof Error ? error.message : String(error), 400)
  }
  await mkdir(folder, { recursive: true })
  for (let index = 1; index < 1000; index += 1) {
    const target = join(folder, numbered(safe, index))
    // `wx` fails when the name is taken, so two drops of the same file never race onto one name.
    const handle = await open(target, 'wx').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return undefined
      throw error
    })
    if (!handle) continue
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
    return { path: relative(workspace, target).replaceAll('\\', '/'), size: bytes.byteLength }
  }
  throw new FileServeError(`too many files named ${safe}`, 409)
}
