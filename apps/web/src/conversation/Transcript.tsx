import { useState, type Ref } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Pencil, GitFork } from 'lucide-react'
import { ToolBlock } from './ToolActivity'
export { ToolGroupBlock } from './ToolActivity'
import { formatCancelCause } from '../projectEvents'
import { prettyJson } from '../api'
import type { DisplayMessage, ContextUsage } from '../types'

interface MessageBlockProps {
  message: DisplayMessage
  active?: boolean
  userRef?: Ref<HTMLDivElement>
  editing?: boolean
  editDraft?: string
  onEditDraftChange?: (value: string) => void
  onBeginEdit?: () => void
  onSubmitEdit?: () => void
  onCancelEdit?: () => void
  onForkAt?: () => void
}

export function MessageBlock({
  message,
  active,
  userRef,
  editing = false,
  editDraft = '',
  onEditDraftChange,
  onBeginEdit,
  onSubmitEdit,
  onCancelEdit,
  onForkAt,
}: MessageBlockProps) {
  if (message.role === 'tool' && message.tool) {
    return <ToolBlock message={message} />
  }
  if (message.role === 'system' && message.compacted) {
    return <CompactionBlock message={message} />
  }
  if (message.role === 'system' && message.slash) {
    return <SlashBlock message={message} />
  }
  if (message.role === 'system') {
    return (
      <div className="message system">
        <div className="message-label">[!]</div>
        <div className="message-body">{message.content}</div>
        <MessageStatus message={message} />
      </div>
    )
  }
  const className = `message ${message.role}${active ? ' active-user' : ''}${editing ? ' editing' : ''}`
  const isUser = message.role === 'user'
  const finishReason = message.finishReason ?? message.endState?.finishReason
  return (
    <div className={className} ref={userRef}>
      <div className="message-label">
        <span>
          {message.role === 'assistant' ? 'Tnega' : 'You'}
          {message.pending ? ' ...' : ''}
          {message.interrupted ? ' / interrupted' : ''}
          {message.retry
            ? ` / retry ${message.retry.retry}${message.retry.started ? ' ...' : ''}`
            : ''}
          {finishReason ? ` / ${finishReason}` : ''}
        </span>
        {isUser && !editing && (onBeginEdit || onForkAt) && (
          <span className="message-menu">
            {onBeginEdit && (
              <button
                type="button"
                className="icon-button"
                onClick={onBeginEdit}
                title="edit"
              >
                <Pencil size={14} />
              </button>
            )}
            {onForkAt && (
              <button
                type="button"
                className="icon-button"
                onClick={onForkAt}
                title="fork here"
              >
                <GitFork size={14} />
              </button>
            )}
          </span>
        )}
      </div>
      {editing ? (
        <div className="message-edit">
          <textarea
            value={editDraft}
            onChange={(event) => onEditDraftChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                onSubmitEdit?.()
              }
              if (event.key === 'Escape') onCancelEdit?.()
            }}
            autoFocus
            spellCheck={false}
            rows={4}
          />
          <div className="message-edit-actions">
            <button
              type="button"
              className="button-primary"
              onClick={onSubmitEdit}
              disabled={!editDraft.trim()}
            >
              [send]
            </button>
            <button type="button" onClick={onCancelEdit} title="cancel">
              [x]
            </button>
          </div>
        </div>
      ) : (
        <div className="message-body md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>
      )}
      <MessageStatus message={message} />
    </div>
  )
}

function MessageStatus({ message }: { message: DisplayMessage }) {
  const parts: string[] = []
  if (message.retry) {
    const delay =
      message.retry.delayMs !== undefined ? ` / ${message.retry.delayMs}ms` : ''
    const failure = message.retry.failure?.message
      ? ` / ${message.retry.failure.message}`
      : ''
    parts.push(`[retry ${message.retry.retry}${delay}${failure}]`)
  }
  if (message.endState?.cancelCause) {
    parts.push(`[cancel ${formatCancelCause(message.endState.cancelCause)}]`)
  }
  if (message.endState?.error) {
    parts.push(`[error: ${message.endState.error.message}]`)
  }
  if (parts.length === 0) return null
  return <div className="message-status">{parts.join(' ')}</div>
}

export function ContextRing({ context }: { context: ContextUsage }) {
  const ratio = Math.min(1, Math.max(0, context.ratio))
  const radius = 11
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - ratio)
  const color =
    ratio >= 0.8
      ? 'var(--danger)'
      : ratio >= 0.5
        ? 'var(--warning)'
        : 'var(--success)'
  const percent = Math.round(context.ratio * 100)
  return (
    <div
      className="context-ring"
      title={`${context.tokens.toLocaleString()} / ${context.limit.toLocaleString()} tokens`}
    >
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
        <circle className="context-ring-track" cx="17" cy="17" r={radius} />
        <circle
          className="context-ring-value"
          cx="17"
          cy="17"
          r={radius}
          stroke={color}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 17 17)"
        />
      </svg>
      <span className="context-ring-label">{percent}%</span>
    </div>
  )
}

function CompactionBlock({ message }: { message: DisplayMessage }) {
  const [open, setOpen] = useState(false)
  const tokens = message.tokensBefore
  const tokenText =
    tokens !== undefined ? `${tokens.toLocaleString()} tokens` : 'context'
  return (
    <div className="message compaction">
      <button
        type="button"
        className="compaction-toggle"
        onClick={() => setOpen((open) => !open)}
      >
        <span className="marker">{open ? '[-]' : '[+]'}</span>
        <span className="compaction-status">[context compacted]</span>
        <span className="compaction-meta">
          {open
            ? `compacted from ${tokenText}`
            : `compacted from ${tokenText} (expand)`}
        </span>
      </button>
      {open && message.content && (
        <div className="compaction-summary md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}

function SlashBlock({ message }: { message: DisplayMessage }) {
  const [open, setOpen] = useState(true)
  const slash = message.slash!
  const line = [slash.command, ...slash.args].join(' ')
  return (
    <div className="message slash">
      <button
        type="button"
        className="slash-toggle"
        onClick={() => setOpen((open) => !open)}
        aria-expanded={open}
      >
        <span className="marker">{open ? '[-]' : '[+]'}</span>
        <span className="slash-status">slash</span>
        <span className="slash-block-command" title={line}>
          {line}
        </span>
      </button>
      {open && (
        <div className="slash-result">
          {slash.result.kind === 'text' ? (
            <div className="slash-text md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {slash.result.text}
              </ReactMarkdown>
            </div>
          ) : (
            <pre className="slash-json">{prettyJson(slash.result.value)}</pre>
          )}
        </div>
      )}
    </div>
  )
}
