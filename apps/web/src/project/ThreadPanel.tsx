import { useMemo } from 'react'
import { ChevronRight, Loader2, X } from 'lucide-react'
import { Composer, type ComposerProps } from './Composer'
import { projectEvents, type DisplayMessage } from './reuse'
import { threadStateLabel } from './state'
import { markOf, type PlanStep } from './steps'
import type { SessionEvent, ThreadRecord } from './types'

export interface ThreadPanelProps {
  thread?: ThreadRecord
  steps: readonly PlanStep[]
  events: readonly SessionEvent[]
  loading: boolean
  onClose: () => void
  composer: ComposerProps
}

/**
 * Thread 面板：一个 Thread 自己的执行视图。
 *
 * 面包屑说明「你在哪」，上下文块说明「它被交代了什么」，计划卡片说明「它做到哪一步」，
 * 下面才是对话本身。计划与工具状态都是结构化对象，不是从回复正文里读出来的。
 */
export function ThreadPanel(props: ThreadPanelProps) {
  const transcript = useMemo(() => projectEvents([...props.events]), [props.events])
  const { thread } = props

  return (
    <aside className="thread-panel" aria-label="Thread">
      <header className="thread-panel-head">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <span>Threads</span>
          <ChevronRight size={12} aria-hidden="true" />
          <span className="breadcrumb-current">{thread?.label ?? 'Thread'}</span>
        </nav>
        <button type="button" className="icon-button" onClick={props.onClose} aria-label="Close thread">
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="thread-panel-scroll">
        <section className="panel-card context-card">
          <div className="context-row">
            <span className="context-label">State</span>
            <span className="context-value">
              {thread ? threadStateLabel(thread.state) : 'loading'}
              {thread?.state === 'working' && <Loader2 size={11} className="spin" aria-hidden="true" />}
            </span>
          </div>
          <div className="context-row">
            <span className="context-label">Goal</span>
            <span className="context-value">{thread?.goal ?? '—'}</span>
          </div>
          {thread?.expect && (
            <div className="context-row">
              <span className="context-label">Expects</span>
              <span className="context-value">{thread.expect}</span>
            </div>
          )}
          <div className="context-row">
            <span className="context-label">Permission</span>
            <span className="context-value">{thread?.permission ?? 'read-only'}</span>
          </div>
          {thread?.detail && (
            <div className="context-row">
              <span className="context-label">Latest</span>
              <span className="context-value">{thread.detail}</span>
            </div>
          )}
        </section>

        {!!props.steps.length && (
          <section className="panel-card">
            <h3 className="panel-card-title">Execution plan</h3>
            <ol className="steps">
              {props.steps.map(step => (
                <li key={step.id} data-mark={step.mark} title={step.detail}>
                  <span className="step-mark" aria-hidden="true">{markOf(step.mark)}</span>
                  <span className="step-title">{step.title}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="panel-card thread-transcript">
          {props.loading && !transcript.length && <p className="panel-empty">Loading…</p>}
          {!props.loading && !transcript.length && (
            <p className="panel-empty">Nothing yet — this thread has not run.</p>
          )}
          {transcript.map(message => (
            <TranscriptRow key={message.id} message={message} />
          ))}
        </section>
      </div>

      <Composer {...props.composer} />
    </aside>
  )
}

function TranscriptRow({ message }: { message: DisplayMessage }) {
  if (message.role === 'tool') {
    const tool = message.tool
    return (
      <details className="tool-row" data-ok={tool?.ok}>
        <summary>
          <span className="tool-name">{tool?.name ?? 'tool'}</span>
          <span className="tool-state">
            {tool?.status === 'pending' ? 'running' : tool?.ok === false ? 'failed' : 'done'}
          </span>
        </summary>
        <pre className="tool-detail">{tool?.outputText || tool?.errorText || tool?.argumentsText}</pre>
      </details>
    )
  }
  if (message.role === 'system' || message.role === 'file-edits') return null
  return (
    <article className="bubble" data-role={message.role === 'user' ? 'user' : 'agent'}>
      <p>{message.content}</p>
    </article>
  )
}
