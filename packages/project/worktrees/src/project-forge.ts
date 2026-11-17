import { githubPullRequest } from './project-pr-state.js'
import type { ProjectGitCommand } from './project-worktrees.js'

/**
 * Where a thread's pull request is opened and checked. The default asks the
 * `gh` CLI where the checkout is; a server asks GitHub's REST API from the
 * host with the member's own token, so a box needs only `git` (its push gets
 * the key from the egress proxy) and never holds the token.
 */
export interface PullRequestForge {
  /** Pull requests whose head is `branch`, newest first. */
  list(repo: string, branch: string, signal?: AbortSignal): Promise<ForgePullRequest[]>
  create(repo: string, input: { head: string; base: string; title: string; body: string }, signal?: AbortSignal): Promise<void>
  /** The pull request whose head is `branch`. */
  view(repo: string, branch: string, signal?: AbortSignal): Promise<ForgePullRequest & { headRefOid: string }>
}

export interface ForgePullRequest {
  url: string
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
}

function forgeState(value: unknown): ForgePullRequest['state'] {
  if (value === 'OPEN' || value === 'CLOSED' || value === 'MERGED') return value
  throw new Error('Invalid pull request response')
}

function ghEntry(value: unknown): ForgePullRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid pull request response')
  const url: unknown = Reflect.get(value, 'url')
  const number: unknown = Reflect.get(value, 'number')
  if (typeof url !== 'string' || typeof number !== 'number') throw new Error('Invalid pull request response')
  return { url, number, state: forgeState(Reflect.get(value, 'state')) }
}

/** The GitHub CLI, run where the checkout is. `bodyFile` writes a body to a file `gh` can read, when it can. */
export function ghForge(command: ProjectGitCommand, cwd: string, bodyFile?: (body: string, use: (path: string) => Promise<void>) => Promise<void>): PullRequestForge {
  const gh = (args: string[], signal?: AbortSignal) => command('gh', args, cwd, signal)
  return {
    list: async (repo, branch, signal) => {
      const parsed: unknown = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'url,number,state'], signal))
      if (!Array.isArray(parsed)) throw new Error('Invalid pull request response')
      return parsed.map(ghEntry)
    },
    create: async (repo, input, signal) => {
      const args = ['pr', 'create', '--repo', repo, '--head', input.head, '--base', input.base, '--title', input.title]
      if (bodyFile) await bodyFile(input.body, async path => { await gh([...args, '--body-file', path], signal) })
      else await gh([...args, '--body', input.body], signal)
    },
    view: async (repo, branch, signal) => {
      const parsed: unknown = JSON.parse(await gh(['pr', 'view', branch, '--repo', repo, '--json', 'url,number,state,headRefOid'], signal))
      const entry = ghEntry(parsed)
      const head: unknown = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'headRefOid') : undefined
      if (typeof head !== 'string') throw new Error('Invalid pull request response')
      return { ...entry, headRefOid: head }
    },
  }
}

function apiEntry(value: unknown): ForgePullRequest & { headRefOid: string } {
  if (!value || typeof value !== 'object') throw new Error('Invalid pull request response')
  const url: unknown = Reflect.get(value, 'html_url')
  const number: unknown = Reflect.get(value, 'number')
  const head: unknown = Reflect.get(Reflect.get(value, 'head') ?? {}, 'sha')
  const merged = Reflect.get(value, 'merged') === true || typeof Reflect.get(value, 'merged_at') === 'string'
  const state: unknown = Reflect.get(value, 'state')
  if (typeof url !== 'string' || typeof number !== 'number' || typeof head !== 'string') throw new Error('Invalid pull request response')
  return { url, number, headRefOid: head, state: merged ? 'MERGED' : state === 'open' ? 'OPEN' : 'CLOSED' }
}

/**
 * GitHub's REST API. `token` answers the member's key; without one, nothing
 * can be opened and delivery reports the blocker.
 */
export function githubApiForge(options: { token: () => Promise<string | undefined>; fetch?: typeof fetch; api?: string }): PullRequestForge {
  const get = options.fetch ?? fetch
  const api = options.api ?? 'https://api.github.com'
  const call = async (path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> => {
    const token = await options.token()
    if (!token) throw new Error('No GitHub key: save a GITHUB_TOKEN secret for this folder, then retry')
    const response = await get(`${api}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tnega',
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) {
      let message = text.slice(0, 200)
      try {
        const parsed: unknown = JSON.parse(text)
        const detail: unknown = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'message') : undefined
        if (typeof detail === 'string') message = detail
      } catch { /* not JSON */ }
      throw new Error(`GitHub answered ${response.status}: ${message}`)
    }
    return text ? JSON.parse(text) : undefined
  }
  const parts = (repo: string): { owner: string; name: string } => {
    const parsed = githubPullRequest(`${repo.replace(/\/$/u, '')}/pull/1`)
    if (!parsed) throw new Error(`${repo} is not a GitHub repository`)
    return { owner: parsed.owner, name: parsed.repo }
  }
  const byHead = async (repo: string, branch: string, signal?: AbortSignal): Promise<Array<ForgePullRequest & { headRefOid: string }>> => {
    const { owner, name } = parts(repo)
    const listed = await call(`/repos/${owner}/${name}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&sort=created&direction=desc`, signal ? { signal } : {})
    if (!Array.isArray(listed)) throw new Error('Invalid pull request response')
    return listed.map(apiEntry)
  }
  return {
    list: async (repo, branch, signal) => (await byHead(repo, branch, signal)).map(({ url, number, state }) => ({ url, number, state })),
    create: async (repo, input, signal) => {
      const { owner, name } = parts(repo)
      await call(`/repos/${owner}/${name}/pulls`, { method: 'POST', body: input, ...(signal ? { signal } : {}) })
    },
    view: async (repo, branch, signal) => {
      const found = (await byHead(repo, branch, signal))[0]
      if (!found) throw new Error('Pull request verification failed')
      return found
    },
  }
}
