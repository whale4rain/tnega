import { ExternalLink, GitBranch, GitPullRequest } from 'lucide-react'
import { relativeTime } from '../../lib/hooks'
import type { GitInfo, ResourceFact } from '../../lib/project-types'

const STATUS: Record<GitInfo['status'], { label: string; tone: 'success' | 'neutral' | 'danger' }> = {
  pushed: { label: 'Pushed', tone: 'success' },
  opened: { label: 'Opened', tone: 'success' },
  'up-to-date': { label: 'Up to date', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
}

/** Only web pages open from a card; a remote on disk or behind a local proxy has none. */
function webUrl(uri: string): string | undefined {
  return /^https?:\/\//i.test(uri) ? uri : undefined
}

/**
 * A push or pull request a thread made: what happened, where, its status,
 * and a button that opens it in the browser (the desktop app hands it to the
 * system browser).
 */
export function GitCard({ resource, author }: { resource: ResourceFact; author?: string | undefined }) {
  const git = resource.data.git
  if (!git) return null
  const status = STATUS[git.status]
  const url = webUrl(resource.data.uri)
  const Icon = git.kind === 'pull-request' ? GitPullRequest : GitBranch
  const meta = [git.repo, author, relativeTime(resource.updatedAt)].filter(Boolean).join(' · ')
  return (
    <div className={`git-card tone-${status.tone}`} role="group" aria-label={`${resource.data.title}: ${status.label}`}>
      <Icon size={14} className="git-card-icon" aria-hidden />
      <span className="git-card-body">
        <span className="git-card-title" title={resource.data.title}>{resource.data.title}</span>
        <span className="git-card-meta" title={git.detail ?? meta}>{git.detail ?? meta}</span>
      </span>
      <span className={`pill git-card-status tone-${status.tone}`}>{status.label}</span>
      {url && (
        <a className="button ghost small git-card-open" href={url} target="_blank" rel="noreferrer noopener" title={`Open ${url} in the browser`}>
          <ExternalLink size={12} aria-hidden /> Open
        </a>
      )}
    </div>
  )
}
