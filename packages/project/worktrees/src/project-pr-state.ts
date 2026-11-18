import { execFile } from 'node:child_process'
import type { FactRecord } from '@tnega/blackboard'

/**
 * Where a pull request a thread opened stands now. The git card records what
 * `gh pr create` printed; whether it was merged or closed later happens on the
 * forge, so the host asks `gh` (with the user's own login) and remembers the
 * answer for a while. Nothing here blocks a response: a read returns what is
 * known and refreshes in the background, and the UI polls.
 */
export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed'

/** One pull request in the project list: enough for a sidebar mark and its tooltip. */
export interface ProjectPullRequest {
  url: string
  number?: number
  repo?: string
  /** The thread that opened it. */
  threadId: string
  state: PullRequestState
}

export type PullRequestLookup = (url: string) => Promise<PullRequestState | undefined>

/** Open and draft pull requests change; merged and closed ones do not. */
const FRESH_MS = 60_000
/** After `gh` is missing or fails, wait this long before trying it again. */
const RETRY_MS = 10 * 60_000
const LOOKUP_TIMEOUT_MS = 10_000

export function isPullRequestState(value: unknown): value is PullRequestState {
  return value === 'open' || value === 'draft' || value === 'merged' || value === 'closed'
}

/** `gh pr view --json state,isDraft` → a state; anything else is unknown. */
export function parseGhState(stdout: string): PullRequestState | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const state: unknown = Reflect.get(parsed, 'state')
  const draft: unknown = Reflect.get(parsed, 'isDraft')
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  if (state === 'OPEN') return draft === true ? 'draft' : 'open'
  return undefined
}

/** Ask the GitHub CLI; resolves `undefined` when it is not installed, not logged in, or the forge is not GitHub. */
export const ghLookup: PullRequestLookup = url => new Promise(resolve => {
  execFile('gh', ['pr', 'view', url, '--json', 'state,isDraft'], { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
    resolve(error ? undefined : parseGhState(String(stdout)))
  })
})

/** `https://github.com/<owner>/<repo>/pull/<n>` → its parts; anything else is not a GitHub pull request. */
export function githubPullRequest(url: string): { owner: string; repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/iu.exec(url)
  if (!match?.[1] || !match[2] || !match[3]) return undefined
  return { owner: match[1], repo: match[2], number: Number(match[3]) }
}

/** The REST answer for one pull request → a state. */
export function parseApiState(body: unknown): PullRequestState | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const state: unknown = Reflect.get(body, 'state')
  if (Reflect.get(body, 'merged') === true || typeof Reflect.get(body, 'merged_at') === 'string') return 'merged'
  if (state === 'closed') return 'closed'
  if (state === 'open') return Reflect.get(body, 'draft') === true ? 'draft' : 'open'
  return undefined
}

/**
 * Ask GitHub's REST API from this host, with the member's own token when they
 * saved one. A server uses it instead of {@link ghLookup}: the `gh` login on
 * the server is nobody's, and a thread's box is paused most of the time.
 */
export function githubApiLookup(options: { token: () => Promise<string | undefined>; fetch?: typeof fetch }): PullRequestLookup {
  const get = options.fetch ?? fetch
  return async url => {
    const pr = githubPullRequest(url)
    if (!pr) return undefined
    const token = await options.token().catch(() => undefined)
    const response = await get(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tnega',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    return parseApiState(await response.json())
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function uriOf(fact: FactRecord): string | undefined {
  const uri = field(fact.data, 'uri')
  return typeof uri === 'string' && /^https?:\/\//i.test(uri) ? uri : undefined
}

/** Pull requests a thread opened, as Library resources record them. */
export function openedPullRequests(resources: readonly FactRecord[]): Array<{ fact: FactRecord; url: string; recorded: PullRequestState }> {
  return resources.flatMap(fact => {
    if (fact.deleted) return []
    const git = field(fact.data, 'git')
    const url = uriOf(fact)
    if (!url || field(git, 'kind') !== 'pull-request' || field(git, 'status') !== 'opened') return []
    const state = field(git, 'state')
    return [{ fact, url, recorded: isPullRequestState(state) ? state : 'open' }]
  })
}

export class PullRequestStates {
  private readonly known = new Map<string, { state: PullRequestState; at: number }>()
  private readonly pending = new Set<string>()
  private pausedUntil = 0

  constructor(
    private readonly lookup: PullRequestLookup = ghLookup,
    private readonly now: () => number = Date.now,
  ) {}

  /** What is known about `url` now; starts a refresh when the answer may be stale. */
  current(url: string, recorded: PullRequestState): PullRequestState {
    const known = this.known.get(url)
    const settled = known && (known.state === 'merged' || known.state === 'closed')
    if (!settled && (!known || this.now() - known.at > FRESH_MS)) this.refresh(url)
    return known?.state ?? recorded
  }

  /** Wait for refreshes in flight (tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await new Promise(resolve => setTimeout(resolve, 5))
  }

  private refresh(url: string): void {
    if (this.pending.has(url) || this.now() < this.pausedUntil) return
    this.pending.add(url)
    void this.lookup(url).then(state => {
      if (state) this.known.set(url, { state, at: this.now() })
      // No answer usually means no `gh` or no login: stop asking for a while instead of spawning on every poll.
      else this.pausedUntil = this.now() + RETRY_MS
    }, () => {
      this.pausedUntil = this.now() + RETRY_MS
    }).finally(() => this.pending.delete(url))
  }

  /** The list entry's pull requests, newest change first. */
  summarize(resources: readonly FactRecord[]): ProjectPullRequest[] {
    return openedPullRequests(resources)
      .sort((a, b) => b.fact.updatedAt - a.fact.updatedAt)
      .map(({ fact, url, recorded }) => {
        const git = field(fact.data, 'git')
        const number = field(git, 'number')
        const repo = field(git, 'repo')
        return {
          url,
          ...(typeof number === 'number' ? { number } : {}),
          ...(typeof repo === 'string' ? { repo } : {}),
          threadId: fact.author,
          state: this.current(url, recorded),
        }
      })
  }

  /** Resources with each opened pull request's current state written into its `git` part. */
  decorate(resources: readonly FactRecord[]): FactRecord[] {
    const opened = new Map(openedPullRequests(resources).map(item => [item.fact, item]))
    return resources.map(fact => {
      const item = opened.get(fact)
      if (!item) return fact
      const git = Object.assign({}, field(fact.data, 'git'), { state: this.current(item.url, item.recorded) })
      return { ...fact, data: Object.assign({}, fact.data, { git }) }
    })
  }
}
