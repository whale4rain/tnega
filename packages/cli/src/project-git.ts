import type { BlackboardService } from '@tnega/blackboard'
import type { Context } from '@tnega/core'
import type { SessionEvent } from '@tnega/session'

/**
 * Pushes and pull requests a thread makes with its shell become cards: the
 * Library records them as resources, and the Web UI shows their status with
 * a link to open them in the browser. Nothing here talks to a forge; the
 * card reports what the command itself printed.
 */
export interface GitOutcome {
  kind: 'push' | 'pull-request'
  status: 'pushed' | 'up-to-date' | 'rejected' | 'failed' | 'opened'
  /** Short card title, e.g. "Pushed feature-x" or "Pull request #12". */
  title: string
  /** Browser URL: the pull request, its "create" page, or the branch; absent for a remote with no web page. */
  url?: string
  /** `owner/repo` (or the remote's path) for the card's subtitle. */
  repo?: string
  branch?: string
  number?: number
  /** The command's last error line when it failed. */
  detail?: string
}

/** Resource data for a git outcome: an ordinary Library resource with a `git` part. */
export interface GitResourceData extends Record<string, unknown> {
  title: string
  uri: string
  note?: string
  git: Omit<GitOutcome, 'title' | 'url'>
}

const PUSH = /(?:^|[\s;&|(])git(?:\s+-[cC]\s+\S+)*\s+push\b/
const PR_CREATE = /(?:^|[\s;&|(])gh\s+pr\s+create\b/
const PR_URL = /https?:\/\/[^\s'"<>)]+\/(?:pull|merge_requests)\/(\d+)\b/
const PR_NEW_URL = /https?:\/\/[^\s'"<>)]+\/(?:pull\/new|merge_requests\/new)[^\s'"<>)]*/
const TO_REMOTE = /^To\s+(\S+)/m
const UPDATED_REF = /^\s*(?:[+*=!-]|\s)\s*(?:\[[^\]]+\]|[0-9a-f]+\.\.\.?[0-9a-f]+)\s+(\S+)\s+->\s+(\S+)/m

/** `https://github.com/o/r.git` / `git@github.com:o/r.git` → `https://github.com/o/r`; local paths and proxies → undefined. */
export function remoteWebUrl(remote: string): string | undefined {
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(remote)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  let url: URL
  try {
    url = new URL(remote)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  // A loopback host is a local proxy or test server, not a page anyone can open.
  if (/^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(url.hostname)) return undefined
  const path = url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')
  if (!/^\/[^/]+\/[^/]+/.test(path)) return undefined
  return `${url.protocol}//${url.host}${path}`
}

function repoName(remote: string | undefined, web: string | undefined): string | undefined {
  if (web) return new URL(web).pathname.slice(1)
  if (!remote) return undefined
  const tail = remote.replace(/\.git\/?$/, '').split(/[\\/:]/).filter(Boolean).slice(-2).join('/')
  return tail || undefined
}

function lastErrorLine(text: string): string | undefined {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const error = lines.findLast(line => /^(?:error|fatal|!|remote: error)/i.test(line)) ?? lines.at(-1)
  return error ? (error.length > 200 ? `${error.slice(0, 199)}…` : error) : undefined
}

/** What a shell command's output says about a push or a pull request, if it made one. */
export function gitOutcome(command: string, output: { exitCode?: number; stdout?: string; stderr?: string }): GitOutcome | undefined {
  const text = `${output.stdout ?? ''}\n${output.stderr ?? ''}`
  const ok = output.exitCode === 0
  if (PR_CREATE.test(command)) {
    const match = PR_URL.exec(text)
    if (ok && match) {
      const number = Number(match[1])
      const url = match[0]
      const repo = new URL(url).pathname.split('/').slice(1, 3).join('/')
      return { kind: 'pull-request', status: 'opened', title: `Pull request #${number}`, url, repo, number }
    }
    if (ok) return undefined
    const detail = lastErrorLine(text)
    return { kind: 'pull-request', status: 'failed', title: 'Pull request not opened', ...(detail ? { detail } : {}) }
  }
  if (!PUSH.test(command)) return undefined
  const remote = TO_REMOTE.exec(text)?.[1]
  const web = remote ? remoteWebUrl(remote) : undefined
  const repo = repoName(remote, web)
  const ref = UPDATED_REF.exec(text)
  const branch = ref?.[2]?.replace(/^refs\/heads\//, '')
  const upToDate = /Everything up-to-date/.test(text)
  const rejected = /\[rejected\]|\[remote rejected\]|non-fast-forward/.test(text)
  const status: GitOutcome['status'] = ok ? (upToDate && !ref ? 'up-to-date' : 'pushed') : rejected ? 'rejected' : 'failed'
  // GitHub and GitLab print where to open a pull request for a new branch; otherwise the branch page.
  const create = PR_NEW_URL.exec(text)?.[0]
  const url = create ?? (web && branch ? `${web}/tree/${branch}` : web)
  const detail = ok ? undefined : lastErrorLine(text)
  const title = status === 'pushed' ? `Pushed ${branch ?? 'commits'}`
    : status === 'up-to-date' ? 'Push: already up to date'
      : status === 'rejected' ? `Push rejected${branch ? `: ${branch}` : ''}` : 'Push failed'
  return {
    kind: 'push', status, title,
    ...(url ? { url } : {}),
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
    ...(detail ? { detail } : {}),
  }
}

/** One card per pull request, per pushed branch, and per repo for failures: a new push updates it. */
export function gitResourceId(outcome: GitOutcome): string {
  const key = outcome.kind === 'pull-request'
    ? `pr:${outcome.url ?? 'failed'}`
    : `push:${outcome.repo ?? 'remote'}:${outcome.branch ?? '*'}`
  return `git-${Buffer.from(key).toString('base64url').slice(0, 80)}`
}

export function gitResourceData(outcome: GitOutcome): GitResourceData {
  const { title, url, ...git } = outcome
  return { title, uri: url ?? '', ...(outcome.detail ? { note: outcome.detail } : {}), git }
}

function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const command: unknown = Reflect.get(args, 'command')
  return typeof command === 'string' ? command : undefined
}

function shellOutput(output: unknown): { exitCode?: number; stdout?: string; stderr?: string } | undefined {
  if (typeof output !== 'object' || output === null) return undefined
  const exitCode: unknown = Reflect.get(output, 'exitCode')
  const stdout: unknown = Reflect.get(output, 'stdout')
  const stderr: unknown = Reflect.get(output, 'stderr')
  return {
    ...(typeof exitCode === 'number' ? { exitCode } : {}),
    ...(typeof stdout === 'string' ? { stdout } : {}),
    ...(typeof stderr === 'string' ? { stderr } : {}),
  }
}

/**
 * Watch every Agent in a project scope: when a shell command pushes or opens
 * a pull request, record the outcome as a Library resource authored by that
 * Agent. The listeners belong to the project scope and go with it.
 */
export function trackGitOutcomes(ctx: Context, board: BlackboardService, agents: Iterable<{ id: string; ctx: Context }>): void {
  const watched = new Set<string>()
  let tail: Promise<void> = Promise.resolve()
  const watch = (agentId: string, agent: { ctx: Context }): void => {
    if (watched.has(agentId)) return
    watched.add(agentId)
    const commands = new Map<string, string>()
    agent.ctx.on('session/event', (event: SessionEvent) => {
      if (event.type === 'tool/call') {
        const command = event.payload.name === 'shell' ? commandOf(event.payload.arguments) : undefined
        if (command && (PUSH.test(command) || PR_CREATE.test(command))) commands.set(event.payload.id, command)
        return
      }
      if (event.type !== 'tool/result') return
      const id = event.payload.toolCallId ?? event.payload.id
      const command = commands.get(id)
      if (!command) return
      commands.delete(id)
      const output = shellOutput(event.payload.output)
      const outcome = output && gitOutcome(command, output)
      if (!outcome) return
      const resourceId = gitResourceId(outcome)
      // A later push to the same branch updates its card, so read the version first; one write at a time.
      tail = tail.then(async () => {
        const current = await board.read('resource', resourceId)
        await board.commit({
          kind: 'resource',
          id: resourceId,
          data: gitResourceData(outcome),
          author: agentId,
          source: { agentId, sessionEventId: event.id },
          expectedVersion: current ? current.version : null,
        })
      }).catch(() => undefined)
    })
  }
  for (const agent of agents) watch(agent.id, agent)
  ctx.on('agent/created', (event: { id: string; agent: { ctx: Context } }) => watch(event.id, event.agent))
}
