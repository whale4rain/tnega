import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, writeFile, rename, rm, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseThreadWorkspace, type ThreadWorkspace } from '@tnega/thread'
import { remoteWebUrl } from './project-git.js'
import { ghForge, type PullRequestForge } from './project-forge.js'

const exec = promisify(execFile)
export type ProjectGitCommand = (command: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<string>
const runCommand: ProjectGitCommand = async (command, args, cwd, signal) => {
  const { stdout } = await exec(command, args, { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 2_000_000, ...(signal ? { signal } : {}) })
  return stdout.trim()
}

/** Git may expand Windows 8.3 aliases or return a differently cased path. */
async function pathIdentity(path: string): Promise<string> {
  let absolute: string
  try { absolute = await realpath(path) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    absolute = resolve(path)
  }
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export interface ProjectWorktreesOptions {
  /**
   * The checkouts are on another machine (a thread's box): `command` runs
   * there, so this process never makes their folders, and a pull request's
   * body goes on the command line instead of through a file here.
   */
  remote?: boolean
  /** Open and check pull requests here instead of with `gh` where the checkout is. */
  forge?: PullRequestForge
}

/** Durable checkouts are deliberately retained on dispose: never delete unmerged work. */
export class ProjectWorktrees {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly root: string, private readonly state: string, private readonly projectId: string, private readonly command: ProjectGitCommand = runCommand, private readonly checkoutRoot = join(state, 'worktrees'), private readonly options: ProjectWorktreesOptions = {}) {}

  prepare(threadId: string, saved?: ThreadWorkspace): Promise<ThreadWorkspace | undefined> {
    const task = this.tail.catch(() => undefined).then(() => this.prepareOnce(threadId, saved))
    this.tail = task
    return task
  }

  private async prepareOnce(threadId: string, saved?: ThreadWorkspace): Promise<ThreadWorkspace | undefined> {
    if (!/^[a-zA-Z0-9-]+$/.test(threadId) || !/^[a-zA-Z0-9-]+$/.test(this.projectId)) throw new Error('Invalid worktree identity')
    let prefix: string
    try { prefix = await this.command('git', ['rev-parse', '--show-prefix'], this.root) }
    catch (error) {
      if (!saved && error instanceof Error && /not a git repository/i.test(error.message)) return undefined
      throw error
    }
    const checkout = resolve(this.checkoutRoot, threadId)
    const cwd = resolve(checkout, prefix)
    const branch = threadBranch(this.projectId, threadId)
    const manifest = join(this.state, 'worktree-records', `${threadId}.json`)
    let workspace = saved
    if (!workspace) {
      try {
        workspace = parseThreadWorkspace(JSON.parse(await readFile(manifest, 'utf8')))
        if (!workspace) throw new Error('Invalid saved Thread worktree metadata')
      }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    }
    if (workspace && (await pathIdentity(workspace.cwd) !== await pathIdentity(cwd) || workspace.branch !== branch)) throw new Error('Thread worktree identity mismatch')
    if (!workspace) {
      const baseCommit = await this.command('git', ['rev-parse', 'HEAD'], this.root)
      let baseBranch: string
      try { baseBranch = (await this.command('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], this.root)).replace(/^origin\//, '') }
      catch { baseBranch = await this.command('git', ['symbolic-ref', '--short', 'HEAD'], this.root) }
      workspace = { cwd, branch, baseCommit, baseBranch }
      await mkdir(join(this.state, 'worktree-records'), { recursive: true })
      const temporary = `${manifest}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(workspace))
      await rename(temporary, manifest)
    }
    const entries = await this.command('git', ['worktree', 'list', '--porcelain', '-z'], this.root)
    const checkoutIdentity = await pathIdentity(checkout)
    let block: string[] | undefined
    for (const entry of entries.split('\0\0')) {
      const fields = entry.split('\0')
      const path = fields.find(field => field.startsWith('worktree '))?.slice(9)
      if (path && await pathIdentity(path) === checkoutIdentity) {
        block = fields
        break
      }
    }
    if (block) {
      if (!block.includes(`branch refs/heads/${branch}`)) throw new Error('Thread worktree branch changed; restore its original branch before continuing')
      await this.command('git', ['rev-parse', '--show-toplevel'], cwd)
      return workspace
    }
    // `git worktree add` makes the folders it needs; only a checkout on this machine needs its root first.
    if (!this.options.remote) await mkdir(this.checkoutRoot, { recursive: true })
    let branchExists = false
    try { await this.command('git', ['show-ref', '--verify', `refs/heads/${branch}`], this.root); branchExists = true } catch { /* new branch */ }
    // A checkout made in a box is recorded under the box's path, which this host's git cannot see:
    // locked, it is never pruned from here as missing. Deleting the project removes it.
    const lock = this.options.remote ? ['--lock'] : []
    await this.command('git', branchExists ? ['worktree', 'add', ...lock, checkout, branch] : ['worktree', 'add', ...lock, '-b', branch, checkout, workspace.baseCommit], this.root)
    return workspace
  }

  async completion(workspace: ThreadWorkspace): Promise<string | undefined> {
    const dirty = await this.command('git', ['status', '--porcelain'], workspace.cwd)
    const changed = await this.command('git', ['diff', '--name-only', workspace.baseCommit, 'HEAD'], workspace.cwd)
    if (!dirty && !changed) return undefined
    const head = await this.command('git', ['rev-parse', 'HEAD'], workspace.cwd)
    if (!dirty && workspace.pullRequest?.headCommit === head) return undefined
    return 'Code changes are not delivered. Commit and verify your changes, then call deliver_thread to open or update this Thread’s pull request. If remote access is unavailable, report the blocker.'
  }

  async deliver(workspace: ThreadWorkspace, input: { title: string; body: string }, signal?: AbortSignal): Promise<ThreadWorkspace> {
    const git = (args: string[]) => this.command('git', args, workspace.cwd, signal)
    if ((await git(['symbolic-ref', '--short', 'HEAD'])) !== workspace.branch) throw new Error('Thread worktree branch changed')
    if (await git(['status', '--porcelain'])) throw new Error('Commit and verify all Thread changes before delivery')
    if (!await git(['diff', '--name-only', workspace.baseCommit, 'HEAD'])) throw new Error('No code changes to deliver')
    let remote: string
    try { remote = await git(['remote', 'get-url', 'origin']) } catch { throw new Error('No origin remote; configure origin and retry deliver_thread') }
    const repo = remoteWebUrl(remote)
    if (!repo) throw new Error('origin must identify a GitHub repository supported by gh')
    const forge = this.options.forge ?? ghForge(this.command, workspace.cwd, this.options.remote ? undefined : async (body, use) => {
      const bodyFile = join(this.state, `pr-body-${randomUUID()}.md`)
      try {
        await writeFile(bodyFile, body)
        await use(bodyFile)
      } finally { await rm(bodyFile, { force: true }) }
    })
    // Authenticate/query before pushing; a missing credential never pretends to be delivery.
    const previous = (await forge.list(repo, workspace.branch, signal))[0]
    if (previous && previous.state !== 'OPEN') throw new Error('This Thread’s pull request is closed; start a new Thread for further code changes')
    const headCommit = await git(['rev-parse', 'HEAD'])
    await git(['push', '--set-upstream', 'origin', `HEAD:refs/heads/${workspace.branch}`])
    if (!previous) await forge.create(repo, { head: workspace.branch, base: workspace.baseBranch, title: input.title, body: input.body }, signal)
    const confirmed = await forge.view(repo, workspace.branch, signal)
    const { url, number } = confirmed
    if (!/^https:\/\/.+\/pull\/\d+$/.test(url) || confirmed.state !== 'OPEN' || confirmed.headRefOid !== headCommit) throw new Error('Pull request verification failed; retry delivery')
    if (workspace.pullRequest && workspace.pullRequest.url !== url) throw new Error('Thread pull request identity changed')
    return { ...workspace, pullRequest: { url, number, headCommit } }
  }
}

/** What {@link discardThreadWorktrees} did. */
export interface DiscardedWorktrees {
  /** Worktrees whose checkout and git metadata were removed. */
  worktrees: string[]
  branches: string[]
  /** Branches kept because they hold commits found nowhere else. */
  kept: string[]
}

/**
 * Remove the checkouts of a deleted project's threads from a folder's
 * repository, on this host: each thread's git metadata (matched by its
 * checkout folder `…/worktrees/<threadId>`, wherever git recorded it: here or
 * under a box's path), its checkout folder, and its branch when every commit
 * on it is also on a remote branch or the folder's HEAD. A branch with work
 * found nowhere else is kept.
 */
export async function discardThreadWorktrees(input: {
  root: string
  threadIds: readonly string[]
  /** The folders the checkouts live in on this host. */
  checkoutRoots: readonly string[]
  branch: (threadId: string) => string
  /** Where threads' own clones are (`<root>/<threadId>`): their branches are fetched back before the clones go. */
  clones?: string
  command?: ProjectGitCommand
}): Promise<DiscardedWorktrees> {
  const run = input.command ?? runCommand
  const result: DiscardedWorktrees = { worktrees: [], branches: [], kept: [] }
  const ids = new Set(input.threadIds.filter(id => /^[a-zA-Z0-9-]+$/.test(id)))
  if (!ids.size) return result
  let common: string
  try { common = resolve(input.root, await run('git', ['rev-parse', '--git-common-dir'], input.root)) }
  catch { return result }
  const admin = join(common, 'worktrees')
  for (const name of await readdir(admin).catch(() => [])) {
    const recorded = await readFile(join(admin, name, 'gitdir'), 'utf8').catch(() => '')
    // `<checkout>/.git`, with either separator: a box records POSIX paths.
    const checkout = recorded.trim().replace(/[\\/]\.git$/u, '')
    const id = checkout.split(/[\\/]/u).at(-1) ?? ''
    const parent = checkout.split(/[\\/]/u).at(-2)
    if (parent !== 'worktrees' || !ids.has(id)) continue
    await rm(join(admin, name), { recursive: true, force: true })
    result.worktrees.push(id)
  }
  for (const id of ids) {
    const clone = input.clones ? join(input.clones, id) : undefined
    if (clone) {
      // Work a thread committed in its own clone comes back to the folder's repository first,
      // so the rule below decides about it like any other branch.
      const branch = input.branch(id)
      await run('git', ['fetch', '--quiet', clone, `+refs/heads/${branch}:refs/heads/${branch}`], input.root).catch(() => '')
      await rm(clone, { recursive: true, force: true })
    }
    for (const root of input.checkoutRoots) await rm(join(root, id), { recursive: true, force: true })
  }
  await run('git', ['worktree', 'prune'], input.root).catch(() => '')
  for (const id of ids) {
    const branch = input.branch(id)
    let tip: string
    try { tip = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], input.root) }
    catch { continue }
    if (!tip) continue
    const onRemote = await run('git', ['branch', '-r', '--contains', tip], input.root).catch(() => '')
    const inHead = await run('git', ['merge-base', '--is-ancestor', tip, 'HEAD'], input.root).then(() => true, () => false)
    if (!onRemote && !inHead) {
      result.kept.push(branch)
      continue
    }
    try {
      await run('git', ['branch', '-D', branch], input.root)
      result.branches.push(branch)
    } catch {
      result.kept.push(branch)
    }
  }
  return result
}

/** The branch a project's thread works on. */
export function threadBranch(projectId: string, threadId: string): string {
  return `codex/thread-${projectId}-${threadId}`
}
