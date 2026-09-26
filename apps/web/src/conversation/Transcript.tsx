import { memo, useState, type Ref } from 'react'
import { ChatMessage, ChatMessageBubble, ChatSystemMessage } from '@astryxdesign/core/Chat'
import { Button } from '@astryxdesign/core/Button'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { IconButton } from '@astryxdesign/core/IconButton'
import { TextArea } from '@astryxdesign/core/TextArea'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Pencil, GitFork, Bot, ChevronRight, PanelRight, FilePenLine } from 'lucide-react'
import { ToolBlock } from './ToolActivity'
export { ToolGroupBlock } from './ToolActivity'
import { formatCancelCause } from '../projectEvents'
import { prettyJson } from '../api'
import type { DisplayMessage, ContextUsage, EditedFileSummary, SubagentEntry } from '../types'

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
  onOpenSubagent?: (id: string) => void
  subagentStatus?: SubagentEntry['status']
  assistantLabel?: string
}

export const MessageBlock = memo(function MessageBlock({
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
  onOpenSubagent,
  subagentStatus,
  assistantLabel = 'Tnega',
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
      <ChatSystemMessage>
        {message.content}
        <MessageStatus message={message} />
      </ChatSystemMessage>
    )
  }
  if (message.role === 'subagent' && message.subagent) {
    return <SubagentBlock message={message} status={subagentStatus} onOpen={onOpenSubagent} />
  }
  if (message.role === 'file-edits' && message.editedFiles) {
    return <FileEditsBlock files={message.editedFiles} />
  }
  const className = `message ${message.role}${active ? ' active-user' : ''}${editing ? ' editing' : ''}`
  const isUser = message.role === 'user'
  const finishReason = message.finishReason ?? message.endState?.finishReason
  const status = [
    message.pending ? '...' : '',
    message.interrupted ? 'interrupted' : '',
    message.retry ? `retry ${message.retry.retry}${message.retry.started ? ' ...' : ''}` : '',
    finishReason ?? '',
  ].filter(Boolean).join(' / ')
  // 助手名字默认是固定的“Tnega”，每轮都重复一遍没有信息量，不显示；
  // 子代理侧栏会传自己的名字进来，那种是有用的，保留。
  const name = isUser ? 'You' : (assistantLabel === 'Tnega' ? '' : assistantLabel)
  return (
    <ChatMessage sender={isUser ? 'user' : 'assistant'} density="compact" className={className} ref={userRef}>
      {(name || status) && (
        <div className="message-label">
          <span>{[name, status].filter(Boolean).join(' / ')}</span>
          {isUser && !editing && (onBeginEdit || onForkAt) && (
            <span className="message-menu">
              {onBeginEdit && (
                <IconButton label="Edit message" tooltip="Edit message" icon={<Pencil size={14} />} variant="ghost" size="sm" onClick={onBeginEdit} />
              )}
              {onForkAt && (
                <IconButton label="Fork here" tooltip="Fork here" icon={<GitFork size={14} />} variant="ghost" size="sm" onClick={onForkAt} />
              )}
            </span>
          )}
        </div>
      )}
      {editing ? (
        <div className="message-edit">
          <TextArea
            label="Edit message"
            isLabelHidden
            value={editDraft}
            onChange={value => onEditDraftChange?.(value)}
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
            hasAutoFocus
            hasSpellCheck={false}
            rows={4}
          />
          <div className="message-edit-actions">
            <Button label="Send edited message" variant="primary" size="sm" onClick={onSubmitEdit} isDisabled={!editDraft.trim()} />
            <Button label="Cancel editing" variant="ghost" size="sm" onClick={onCancelEdit} />
          </div>
        </div>
      ) : (
        <ChatMessageBubble variant={isUser ? 'filled' : 'ghost'}>
        <div className="message-body md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>
        </ChatMessageBubble>
      )}
      <MessageStatus message={message} />
    </ChatMessage>
  )
})

function FileEditsBlock({ files }: { files: EditedFileSummary[] }) {
  const [expanded, setExpanded] = useState(false)
  const ordered = [...files].sort((a, b) =>
    (b.additions ?? 0) + (b.deletions ?? 0) - (a.additions ?? 0) - (a.deletions ?? 0)
    || a.path.localeCompare(b.path))
  const remaining = files.length - 3
  const hasStats = files.every(file => file.additions !== undefined && file.deletions !== undefined)
  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0)
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0)
  const rows = (list: EditedFileSummary[]) => (
    <ul className="file-edits-list">
      {list.map(file => (
        <li key={file.path} title={file.path}>
          <span className="file-edits-path">
            <span>{file.path.slice(0, file.path.lastIndexOf('/') + 1)}</span>
            <strong>{file.path.slice(file.path.lastIndexOf('/') + 1)}</strong>
          </span>
          {(file.additions !== undefined || file.deletions !== undefined) && (
            <span className="file-edits-stats"><span>+{file.additions ?? 0}</span> <span>-{file.deletions ?? 0}</span></span>
          )}
        </li>
      ))}
    </ul>
  )
  // 收起时只列前三个，并留一个入口展开；按钮排在列表末尾，展开后原地变成“收起”，
  // 这样既不会把列表截成两段，也随时收得回去。
  const collapsed = !expanded && remaining > 0
  return (
    <div className="message file-edits-card">
      <div className="file-edits-heading">
        <span className="file-edits-icon"><FilePenLine size={19} aria-hidden="true" /></span>
        <div className="file-edits-heading-copy">
          <strong>已编辑 {files.length} 个文件</strong>
          {hasStats && <span className="file-edits-stats"><span>+{additions}</span> <span>-{deletions}</span></span>}
        </div>
      </div>
      {rows(collapsed ? ordered.slice(0, 3) : ordered)}
      {remaining > 0 && (
        <Button
          className="file-edits-more"
          label={expanded ? '收起' : `再显示 ${remaining} 个文件`}
          variant="ghost"
          size="sm"
          icon={<ChevronRight size={14} className={expanded ? 'expanded' : undefined} aria-hidden="true" />}
          onClick={() => setExpanded(current => !current)}
        />
      )}
    </div>
  )
}

function SubagentBlock({
  message,
  status,
  onOpen,
}: {
  message: DisplayMessage
  status?: SubagentEntry['status']
  onOpen?: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const subagent = message.subagent
  if (!subagent) return null
  const agentId = subagent.id
  const latest = subagent.replies.at(-1)
  return (
    <div className="message subagent-card">
      <div className="subagent-card-line">
        <button
          type="button"
          className="subagent-card-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        >
          <Bot size={15} aria-hidden="true" />
          <strong>{subagent.label}</strong>
          <span className={`subagent-status ${status ?? subagent.status}`}>
            {status ?? subagent.status}
          </span>
          {latest && <span className="subagent-card-preview">{latest}</span>}
          <ChevronRight size={14} className={expanded ? 'expanded' : ''} aria-hidden="true" />
        </button>
        {agentId && onOpen && (
          <button
            type="button"
            className="subagent-card-open"
            aria-label={`Open ${subagent.label} in tasks sidebar`}
            title="Open task details"
            onClick={() => onOpen(agentId)}
          >
            <PanelRight size={15} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="subagent-card-detail">
          {subagent.task && <p className="subagent-card-task">{subagent.task}</p>}
          {subagent.error && <p className="danger">{subagent.error}</p>}
          {subagent.replies.map((reply, index) => (
            <div className="md" key={`${message.id}-reply-${index}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{reply}</ReactMarkdown>
            </div>
          ))}
        </div>
      )}
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
        <span className="compaction-status">[compaction]</span>
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
  const slash = message.slash!
  const line = [slash.command, ...slash.args].join(' ')
  return (
    <div className="message slash">
      <Collapsible
        trigger={
          <>
            <span className="slash-status">slash</span>
            <span className="slash-block-command">{line}</span>
          </>
        }
      >
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
      </Collapsible>
    </div>
  )
}
