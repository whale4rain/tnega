import { extname } from 'node:path'
import { FsError, type WorkspaceFs } from '@tnega/fs'
import { FileServeError } from './files.js'
import { checkInside } from './workspace-files.js'

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

export async function saveUpload(fs: WorkspaceFs, name: string, bytes: Uint8Array): Promise<SavedUpload> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new FileServeError(`file exceeds ${MAX_UPLOAD_BYTES} bytes`, 413)
  const safe = safeUploadName(name)
  await checkInside(fs, UPLOADS_DIR)
  await fs.mkdir(UPLOADS_DIR)
  for (let index = 1; index < 1000; index += 1) {
    const path = `${UPLOADS_DIR}/${numbered(safe, index)}`
    // Skip names already taken before sending the bytes; the create-only write still settles a race.
    if (await fs.stat(path)) continue
    // A `create` write fails when the name is taken, so two drops of the same file never race onto one name.
    const saved = await fs.writeFile(path, bytes, { mode: 'create' }).then(() => true, (error: unknown) => {
      if (error instanceof FsError && error.code === 'FS_EXISTS') return false
      throw error
    })
    if (saved) return { path, size: bytes.byteLength }
  }
  throw new FileServeError(`too many files named ${safe}`, 409)
}
