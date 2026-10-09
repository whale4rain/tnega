import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseThreadWorkspace, type ThreadWorkspace } from '@tnega/thread'
import { remoteWebUrl } from './project-git.js'

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

/** Durable checkouts are deliberately retained on dispose: never delete unmerged work. */
export class ProjectWorktrees {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly root: string, private readonly state: string, private readonly projectId: string, private readonly command: ProjectGitCommand = runCommand, private readonly checkoutRoot = join(state, 'worktrees')) {}

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
    const branch = `codex/thread-${this.projectId}-${threadId}`
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
    await mkdir(this.checkoutRoot, { recursive: true })
    let branchExists = false
    try { await this.command('git', ['show-ref', '--verify', `refs/heads/${branch}`], this.root); branchExists = true } catch { /* new branch */ }
    await this.command('git', branchExists ? ['worktree', 'add', checkout, branch] : ['worktree', 'add', '-b', branch, checkout, workspace.baseCommit], this.root)
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
    const gh = (args: string[]) => this.command('gh', args, workspace.cwd, signal)
    // Authenticate/query before pushing; a missing credential never pretends to be delivery.
    const existing: unknown = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--head', workspace.branch, '--state', 'all', '--json', 'url,number,state']))
    if (!Array.isArray(existing)) throw new Error('Invalid pull request response')
    const previous: unknown = existing[0]
    if (previous && (typeof previous !== 'object' || Reflect.get(previous, 'state') !== 'OPEN')) throw new Error('This Thread’s pull request is closed; start a new Thread for further code changes')
    const headCommit = await git(['rev-parse', 'HEAD'])
    await git(['push', '--set-upstream', 'origin', `HEAD:refs/heads/${workspace.branch}`])
    if (!previous) {
      const bodyFile = join(this.state, `pr-body-${randomUUID()}.md`)
      try {
        await writeFile(bodyFile, input.body)
        await gh(['pr', 'create', '--repo', repo, '--head', workspace.branch, '--base', workspace.baseBranch, '--title', input.title, '--body-file', bodyFile])
      } finally { await rm(bodyFile, { force: true }) }
    }
    const confirmed: unknown = JSON.parse(await gh(['pr', 'view', workspace.branch, '--repo', repo, '--json', 'url,number,state,headRefOid']))
    if (!confirmed || typeof confirmed !== 'object') throw new Error('Pull request verification failed')
    const url: unknown = Reflect.get(confirmed, 'url')
    const number: unknown = Reflect.get(confirmed, 'number')
    if (typeof url !== 'string' || !/^https:\/\/.+\/pull\/\d+$/.test(url) || typeof number !== 'number' || Reflect.get(confirmed, 'state') !== 'OPEN' || Reflect.get(confirmed, 'headRefOid') !== headCommit) throw new Error('Pull request verification failed; retry delivery')
    if (workspace.pullRequest && workspace.pullRequest.url !== url) throw new Error('Thread pull request identity changed')
    return { ...workspace, pullRequest: { url, number, headCommit } }
  }
}
