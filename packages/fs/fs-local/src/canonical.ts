import { lstat, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isMissingError } from '@tnega/fs'

const MAX_LINK_HOPS = 40

/**
 * The file a path names once every symlink is followed, also for a path that
 * does not exist yet or a link whose target is missing. Locks, read records
 * and the write itself all use this one name, so `link.ts` and `real.ts` are
 * the same file to the guard, and a write never follows a link the fence did
 * not see.
 */
export async function canonicalPath(target: string, hops = 0): Promise<string> {
  try {
    return await realpath(target)
  } catch (error) {
    if (!isMissingError(error)) throw error
  }
  const entry = await lstat(target).catch(() => undefined)
  if (entry?.isSymbolicLink()) {
    if (hops >= MAX_LINK_HOPS) throw new Error(`too many symbolic links: ${target}`)
    const to = await readlink(target)
    return await canonicalPath(isAbsolute(to) ? to : resolve(dirname(target), to), hops + 1)
  }
  const parent = dirname(target)
  if (parent === target) return target
  return join(await canonicalPath(parent, hops), basename(target))
}
