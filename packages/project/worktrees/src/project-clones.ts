import { execFile } from 'node:child_process'
import { lchown, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true, timeout: 300_000, maxBuffer: 2_000_000 })
  return stdout.trim()
}

/**
 * Where a Project thread's own clone of the folder's repository lives on the
 * host: `<folder>/.tnega/clones/<threadId>`. The thread's box mounts only this
 * clone, so threads never see each other's files or the folder's uncommitted
 * ones; they share work through pull requests and the project's artifacts.
 */
export function threadCloneDir(workspace: string, threadId: string): string {
  if (!/^[a-zA-Z0-9-]+$/u.test(threadId)) throw new Error('Invalid thread id')
  return join(threadClonesRoot(workspace), threadId)
}

/** The folder that holds a workspace's thread clones. */
export function threadClonesRoot(workspace: string): string {
  return join(resolve(workspace), '.tnega', 'clones')
}

/** The folder a thread clone belongs to, or `undefined` for a path that is not one. */
export function threadCloneOwner(path: string): string | undefined {
  const parts = resolve(path).split(sep)
  const at = parts.length - 3
  if (at < 1 || parts[at] !== '.tnega' || parts[at + 1] !== 'clones' || !/^[a-zA-Z0-9-]+$/u.test(parts[at + 2] ?? '')) return undefined
  return parts.slice(0, at).join(sep) || sep
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  await lchown(path, uid, gid)
  const entry = await lstat(path)
  if (!entry.isDirectory()) return
  for (const name of await readdir(path)) await chownTree(join(path, name), uid, gid)
}

/**
 * Make a thread's clone if it is not there yet: a local clone of the folder's
 * repository (objects hard-linked where the file system allows, so it is
 * quick), checked out at the folder's HEAD, with `origin` set to the folder's
 * own `origin` so the thread pushes where the folder does. The clone gets the
 * folder's owner, as a box writes as that user. Answers the clone's path, or
 * `undefined` when the folder is not in a git repository (a box for it then
 * mounts the folder itself).
 */
export async function prepareThreadClone(workspace: string, threadId: string): Promise<string | undefined> {
  const clone = threadCloneDir(workspace, threadId)
  if (await stat(join(clone, '.git')).then(() => true, () => false)) return clone
  let top: string
  try { top = await git(workspace, ['rev-parse', '--show-toplevel']) }
  catch { return undefined }
  await mkdir(dirname(clone), { recursive: true })
  const partial = `${clone}.partial`
  await rm(partial, { recursive: true, force: true })
  try {
    await git(top, ['clone', '--quiet', '--local', top, partial])
    const head = await git(top, ['rev-parse', 'HEAD'])
    await git(partial, ['checkout', '--quiet', '--detach', head])
    const origin = await git(top, ['remote', 'get-url', 'origin']).catch(() => '')
    if (origin) await git(partial, ['remote', 'set-url', 'origin', origin])
    else await git(partial, ['remote', 'remove', 'origin'])
    const owner = await stat(workspace)
    if (process.getuid?.() === 0 && owner.uid !== 0) await chownTree(partial, owner.uid, owner.gid)
    await rename(partial, clone)
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }
  return clone
}
