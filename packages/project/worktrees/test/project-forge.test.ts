import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { discardThreadWorktrees, githubApiForge, githubApiLookup, githubPullRequest, threadBranch } from '../src/index.js'

const exec = promisify(execFile)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A fetch that answers from a table of `METHOD path` → JSON, and records what it was asked. */
function fakeGitHub(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; authorization: string | null; body?: unknown }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    calls.push({ method, url, authorization: headers.get('authorization'), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    const path = new URL(url).pathname
    const answer = routes[`${method} ${path}`]
    if (answer === undefined) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    return new Response(JSON.stringify(answer), { status: 200 })
  }
  return { fetcher, calls }
}

describe('GitHub over its API', () => {
  it('reads a pull request\'s state with the member\'s key', async () => {
    const { fetcher, calls } = fakeGitHub({ 'GET /repos/o/r/pulls/7': { state: 'closed', merged: true } })
    const lookup = githubApiLookup({ token: async () => 'ghp_x', fetch: fetcher })
    expect(await lookup('https://github.com/o/r/pull/7')).toBe('merged')
    expect(calls[0]?.authorization).toBe('Bearer ghp_x')
    expect(await lookup('https://gitlab.com/o/r/merge_requests/7')).toBeUndefined()
    expect(githubPullRequest('https://github.com/o/r/pull/7#issuecomment-1')).toEqual({ owner: 'o', repo: 'r', number: 7 })
  })

  it('lists, opens and confirms a thread\'s pull request', async () => {
    const opened = { html_url: 'https://github.com/o/r/pull/9', number: 9, state: 'open', head: { sha: 'abc' } }
    const { fetcher, calls } = fakeGitHub({ 'GET /repos/o/r/pulls': [opened], 'POST /repos/o/r/pulls': opened })
    const forge = githubApiForge({ token: async () => 'ghp_x', fetch: fetcher })
    expect(await forge.list('https://github.com/o/r', 'codex/thread-p-t')).toEqual([{ url: opened.html_url, number: 9, state: 'OPEN' }])
    expect(new URL(calls[0]?.url ?? '').searchParams.get('head')).toBe('o:codex/thread-p-t')
    await forge.create('https://github.com/o/r', { head: 'codex/thread-p-t', base: 'main', title: 'T', body: 'B' })
    expect(calls[1]).toMatchObject({ method: 'POST', body: { head: 'codex/thread-p-t', base: 'main', title: 'T', body: 'B' } })
    expect(await forge.view('https://github.com/o/r', 'codex/thread-p-t')).toEqual({ url: opened.html_url, number: 9, state: 'OPEN', headRefOid: 'abc' })
  })

  it('reports a missing key instead of calling GitHub', async () => {
    const { fetcher, calls } = fakeGitHub({})
    const forge = githubApiForge({ token: async () => undefined, fetch: fetcher })
    await expect(forge.list('https://github.com/o/r', 'b')).rejects.toThrow(/GITHUB_TOKEN/)
    expect(calls).toHaveLength(0)
  })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd })
  return stdout.trim()
}

describe('discardThreadWorktrees', () => {
  it('removes a deleted project\'s checkouts, including ones a box recorded under its own path, and keeps unique work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tnega-discard-'))
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
    await git(root, 'init', '-q', '-b', 'main')
    await git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base')
    const checkouts = join(root, '.tnega', 'worktrees')
    const branch = (id: string) => threadBranch('p1', id)
    // "done": its branch has nothing of its own. "work": a commit found nowhere else.
    for (const id of ['done', 'work']) {
      await git(root, 'worktree', 'add', '-q', '--lock', '-b', branch(id), join(checkouts, id))
    }
    await git(join(checkouts, 'work'), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'unique')
    // Made in a box: git there recorded the box's path, which does not exist on this host.
    const common = join(root, '.git', 'worktrees', 'done')
    await writeFile(join(common, 'gitdir'), '/workspace/.tnega/worktrees/done/.git\n')
    expect(await readFile(join(common, 'gitdir'), 'utf8')).toContain('/workspace/')
    await mkdir(join(root, '.git', 'worktrees', 'other-project'), { recursive: true })
    await writeFile(join(root, '.git', 'worktrees', 'other-project', 'gitdir'), '/workspace/.tnega/worktrees/someone-else/.git\n')
    // Another live thread's box checkout: locked, as a box makes it.
    await writeFile(join(root, '.git', 'worktrees', 'other-project', 'locked'), '')

    const result = await discardThreadWorktrees({ root, threadIds: ['done', 'work'], checkoutRoots: [checkouts], branch })
    expect(result.worktrees.sort()).toEqual(['done', 'work'])
    expect(result.branches).toEqual([branch('done')])
    expect(result.kept).toEqual([branch('work')])
    expect(existsSync(join(checkouts, 'done'))).toBe(false)
    expect(existsSync(join(checkouts, 'work'))).toBe(false)
    expect(existsSync(join(root, '.git', 'worktrees', 'other-project'))).toBe(true)
    expect(await git(root, 'branch', '--list', branch('work'))).toContain(branch('work'))
  })
})
