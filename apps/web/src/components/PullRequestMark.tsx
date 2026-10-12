import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from 'lucide-react'
import { pullRequestMark } from '../lib/project-model'
import type { ProjectPullRequest, PullRequestState } from '../lib/project-types'

export const PULL_REQUEST_ICON: Record<PullRequestState, LucideIcon> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
}

/**
 * Where a project's pull requests stand, as one small icon in the state's
 * colour (open green, draft grey, merged accent, closed red). The label lists
 * each pull request and is its accessible name and tooltip.
 */
export function PullRequestMark({ pullRequests }: { pullRequests: readonly ProjectPullRequest[] | undefined }) {
  const mark = pullRequestMark(pullRequests)
  if (!mark) return null
  const Icon = PULL_REQUEST_ICON[mark.state]
  return (
    <span className={`pr-mark pr-${mark.state}`} role="img" aria-label={mark.label} title={mark.label}>
      <Icon size={12} aria-hidden />
    </span>
  )
}
