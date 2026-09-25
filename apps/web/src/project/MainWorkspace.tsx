import { useMemo } from 'react'
import { Badge } from '@radix-ui/themes'
import { ArrowUpRight, Loader2, MessageSquare } from 'lucide-react'
import { Composer, type ComposerProps } from './Composer'
import { threadStateLabel, type ProjectView } from './state'
import { threadReplies, type PlanStep } from './steps'
import type { BootEnvelope, ThreadRecord } from './types'

export type SidePanel = 'overview' | 'library' | 'memory'

export interface MainWorkspaceProps {
  view: ProjectView
  workspace: string
  plans: ReadonlyMap<string, PlanStep[]>
  panel: SidePanel
  onPanel: (panel: SidePanel) => void
  onOpenThread: (id: string) => void
  composer: ComposerProps
}

/**
 * 主 Workspace：这个 Project 的持续对话。
 *
 * 投影规则：用户发言与协调者回复是消息卡片；派工是一条 Thread 卡片，卡片上直接显示这个
 * Thread 的步骤进度与回复数 —— 它是结构化对象，不是一句「我已经派给某个线程了」。
 */
export function MainWorkspace(props: MainWorkspaceProps) {
  const { view } = props
  const byThread = useMemo(
    () => new Map(view.threads.map(thread => [thread.id, thread])),
    [view.threads],
  )
  const waiting = view.threads.filter(thread => thread.state === 'waiting' || thread.state === 'blocked')

  return (
    <section className="main-workspace" aria-label="Project conversation">
      <header className="workspace-head">
        <div className="workspace-title">
          <span className="workspace-name">{view.project.name}</span>
          <span className="project-path" title={props.workspace}>{props.workspace}</span>
          {view.project.goal && <span className="workspace-goal">{view.project.goal}</span>}
        </div>
        <div className="workspace-actions">
          {!!waiting.length && <Badge color="amber">{waiting.length} waiting on you</Badge>}
          {(['overview', 'library', 'memory'] as const).map(entry => (
            <button
              key={entry}
              type="button"
              className="ghost-button"
              aria-pressed={props.panel === entry}
              onClick={() => props.onPanel(entry)}
            >
              {entry}
            </button>
          ))}
        </div>
      </header>

      <div className="workspace-scroll">
        <div className="workspace-stream">
          {view.messages.map(envelope => (
            <StreamEntry
              key={envelope.messageId}
              envelope={envelope}
              thread={envelope.threadId ? byThread.get(envelope.threadId) : undefined}
              steps={envelope.threadId ? props.plans.get(envelope.threadId) ?? [] : []}
              replies={envelope.threadId ? threadReplies(view.messages, envelope.threadId).length : 0}
              onOpenThread={props.onOpenThread}
            />
          ))}
          {!view.messages.length && (
            <p className="stream-empty">
              Ask for something, or hand a piece of work to a thread.
            </p>
          )}
        </div>
      </div>

      <Composer {...props.composer} />
    </section>
  )
}

function StreamEntry({
  envelope,
  thread,
  steps,
  replies,
  onOpenThread,
}: {
  envelope: BootEnvelope
  thread?: ThreadRecord
  steps: readonly PlanStep[]
  replies: number
  onOpenThread: (id: string) => void
}) {
  if (envelope.kind === 'dispatch') {
    const target = thread?.id ?? envelope.threadId ?? ''
    return (
      <article className="thread-root" data-state={thread?.state ?? 'idle'}>
        <header>
          <span className="thread-root-label">{thread?.label ?? 'Thread'}</span>
          <span className="thread-root-state">
            {thread ? threadStateLabel(thread.state) : 'starting'}
            {thread?.state === 'working' && <Loader2 size={11} className="spin" aria-hidden="true" />}
          </span>
        </header>
        <p className="thread-root-goal">{thread?.goal ?? envelope.text}</p>
        {!!steps.length && (
          <ol className="steps">
            {steps.slice(0, 6).map(step => (
              <li key={step.id} data-mark={step.mark} title={step.detail}>
                <span className="step-mark" aria-hidden="true">{markOf(step.mark)}</span>
                <span className="step-title">{step.title}</span>
              </li>
            ))}
          </ol>
        )}
        <footer>
          <button type="button" className="ghost-button" disabled={!target} onClick={() => onOpenThread(target)}>
            <MessageSquare size={12} aria-hidden="true" />
            {replies === 1 ? '1 reply' : `${replies} replies`}
            <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        </footer>
      </article>
    )
  }

  if (envelope.kind === 'notice') {
    return (
      <p className="stream-notice">
        {envelope.text}
        {envelope.threadId && (
          <button type="button" className="ghost-button" onClick={() => onOpenThread(envelope.threadId!)}>
            Open thread
          </button>
        )}
      </p>
    )
  }

  const role = envelope.sender.kind === 'user' ? 'user' : 'agent'
  return (
    <article className="bubble" data-role={role}>
      <p>{envelope.text}</p>
    </article>
  )
}

export function markOf(mark: PlanStep['mark']): string {
  switch (mark) {
    case 'done': return '✓'
    case 'running': return '●'
    case 'failed': return '✗'
    case 'pending': return '○'
  }
}
