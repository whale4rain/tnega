import { FsError, type FsWriteOptions, type WorkspaceFs } from '@tnega/fs'
import { ToolInputError } from '@tnega/tools'

/** A Buffer view of bytes from the seam, without a copy when they already are one. */
export function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** The file's bytes, or `undefined` when nothing is there. */
export async function readCurrent(fs: WorkspaceFs, target: string): Promise<Buffer | undefined> {
  const info = await fs.stat(target)
  if (!info) return undefined
  return asBuffer(await fs.readFile(target))
}

/**
 * Write through the seam. A refusal the model can act on (the file appeared
 * mid-create, another program holds it) reads as an input error, not a tool bug.
 */
export async function writeThrough(fs: WorkspaceFs, target: string, data: string, options: FsWriteOptions): Promise<void> {
  try {
    await fs.writeFile(target, data, options)
  } catch (error) {
    if (error instanceof FsError) throw new ToolInputError(error.message)
    throw error
  }
}
