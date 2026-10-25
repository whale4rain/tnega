import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ToolInputError } from '../errors.js'

/**
 * Publish a file atomically: the target is either the old content or the new
 * one, never a truncated half.
 *
 * The shape follows the reference harness (`fs-local:writeFileAtomic`), minus
 * its Win32 `ReplaceFileW`/DACL-copy branch, which needs the FFI helper the
 * sandbox package owns:
 *
 * 1. a private staging directory next to the target (`0700`), because publish
 *    must stay on one filesystem and because the sandbox only grants the
 *    workspace;
 * 2. an exclusively created temp file inside it (`0600`), written and `sync`ed
 *    before it is visible to anyone else;
 * 3. `rename` onto the target — a directory-entry swap, atomic on POSIX and on
 *    Windows (`MoveFileEx` with replace);
 * 4. for a target known to be absent, `link` instead: atomic *and* never
 *    overwrites, so a concurrent creator surfaces as `EEXIST` rather than
 *    being silently clobbered.
 *
 * A crash mid-write leaves the old target intact and some staging residue.
 */
export async function writeFileAtomic(
  target: string,
  content: string,
  options: { createOnly?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const { createOnly = false, signal } = options
  signal?.throwIfAborted()
  const directory = dirname(target)
  await mkdir(directory, { recursive: true })
  const stagingDir = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmpdir`)
  const tempPath = join(stagingDir, `${basename(target)}.tmp`)
  signal?.throwIfAborted()
  await mkdir(stagingDir, { mode: 0o700 })
  try {
    // Windows ignores most POSIX mode bits; the calls still narrow POSIX hosts.
    await chmod(stagingDir, 0o700).catch(() => undefined)
    const handle = await open(tempPath, 'wx', 0o600)
    try {
      await chmod(tempPath, 0o600).catch(() => undefined)
      await handle.writeFile(content, { encoding: 'utf8', ...signal ? { signal } : {} })
      await handle.sync()
    } finally {
      await handle.close()
    }
    signal?.throwIfAborted()
    if (createOnly) {
      try {
        await link(tempPath, target)
      } catch (error) {
        // Another writer created the target after we looked: report the race
        // instead of the raw EEXIST, which reads as a tool bug to a model.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ToolInputError(`${basename(target)} appeared while it was being created; read it, then retry`)
        }
        throw error
      }
    } else await rename(tempPath, target)
  } finally {
    // The target is committed (or the write failed); staging residue is inert.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Whether the path exists at all, without following it into a directory. */
export async function exists(target: string): Promise<boolean> {
  return await stat(target).then(() => true, () => false)
}
