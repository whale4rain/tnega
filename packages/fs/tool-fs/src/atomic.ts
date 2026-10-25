import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ToolInputError } from '@tnega/tools'

/** Errors a hard link raises on filesystems that have none (exFAT, some shares). */
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL'])
/** Errors Windows raises while another program holds the target open. */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])
const BUSY_RETRIES_MS = [10, 50, 150]

function code(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

const pause = async (ms: number): Promise<void> => await new Promise(done => setTimeout(done, ms))

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
 * 2. an exclusively created temp file inside it, carrying the target's own
 *    permission bits (an executable script stays executable), written and
 *    `sync`ed before it is visible to anyone else;
 * 3. `rename` onto the target — a directory-entry swap, atomic on POSIX and on
 *    Windows (`MoveFileEx` with replace). While another program holds the
 *    target open on Windows the swap is retried briefly, then the call fails
 *    with the old content intact: a non-atomic fallback would break the
 *    promise above;
 * 4. for a target known to be absent, `link` instead: atomic *and* never
 *    overwrites, so a concurrent creator surfaces as `EEXIST` rather than
 *    being silently clobbered. A filesystem without hard links falls back to
 *    `rename`.
 *
 * `target` is the followed name of the file (the file tools resolve symlinks
 * and fence the result before calling): a link swapped in afterwards is
 * replaced by the rename, never followed out of the workspace.
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
  // Permission bits of the file being replaced; a new file gets the usual
  // default (0666 less the umask) through `open`.
  const mode = createOnly ? undefined : await stat(target).then(stats => stats.mode & 0o7777, () => undefined)
  const stagingDir = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmpdir`)
  const tempPath = join(stagingDir, `${basename(target)}.tmp`)
  signal?.throwIfAborted()
  await mkdir(stagingDir, { mode: 0o700 })
  try {
    // Windows ignores most POSIX mode bits; the calls still narrow POSIX hosts.
    await chmod(stagingDir, 0o700).catch(() => undefined)
    const handle = await open(tempPath, 'wx', mode ?? 0o666)
    try {
      // `open` applies the umask; an existing file keeps exactly its bits.
      if (mode !== undefined) await handle.chmod(mode).catch(() => undefined)
      await handle.writeFile(content, { encoding: 'utf8', ...signal ? { signal } : {} })
      await handle.sync()
    } finally {
      await handle.close()
    }
    signal?.throwIfAborted()
    if (createOnly) await publishNew(tempPath, target)
    else await replace(tempPath, target)
  } finally {
    // The target is committed (or the write failed); staging residue is inert.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function publishNew(tempPath: string, target: string): Promise<void> {
  try {
    await link(tempPath, target)
    return
  } catch (error) {
    // Another writer created the target after we looked: report the race
    // instead of the raw EEXIST, which reads as a tool bug to a model.
    if (code(error) === 'EEXIST') {
      throw new ToolInputError(`${basename(target)} appeared while it was being created; read it, then retry`)
    }
    if (!NO_LINK.has(code(error) ?? '')) throw error
  }
  // No hard links here: a rename is still atomic, it just cannot refuse a file
  // that appeared in the last instant.
  if (await exists(target)) {
    throw new ToolInputError(`${basename(target)} appeared while it was being created; read it, then retry`)
  }
  await rename(tempPath, target)
}

async function replace(tempPath: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempPath, target)
      return
    } catch (error) {
      const busy = process.platform === 'win32' && BUSY.has(code(error) ?? '')
      if (!busy) throw error
      const delay = BUSY_RETRIES_MS[attempt]
      if (delay === undefined) break
      await pause(delay)
    }
  }
  // Still held open after the retries (an editor, a watcher, an antivirus
  // scan, or a real permission denial). Fail with the old content intact.
  throw new ToolInputError(`${basename(target)} is open in another program or not writable; close it and retry`)
}

/** Whether the path exists at all, without following it into a directory. */
export async function exists(target: string): Promise<boolean> {
  return await stat(target).then(() => true, () => false)
}
