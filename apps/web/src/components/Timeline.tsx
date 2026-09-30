import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  FilePen,
  FileText,
  GitBranch,
  Globe,
  Info,
  Layers,
  Brain,
  Pencil,
  RotateCcw,
  Search,
  SquareTerminal,
  Wrench,
  X,
  Network,
} from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import { useCopy } from '../lib/hooks'
import type { Block, Entry, SubagentView, ToolView } from '../lib/timeline'
import { formatDuration, formatTokens, presentRun, stringify } from '../lib/timeline'
import { presentTool, readableOutput, type ToolFamily } from '../lib/tools'
import { AgentAvatar } from './AgentAvatar'
import { CodeBlock, Markdown } from './Markdown'

export interface TimelineActions {
  onEdit?: (entryId: string, text: string) => void
  onRetry?: (entryId: string, text: string) => void
  onFork?: (messageId: string) => void
  onOpenSubagent?: (id: string, label: string) => void
}

/** Whose avatar the agent turns in this timeline wear. */
export interface TimelineAgent {
  id: string
  role?: 'coordinator' | 'agent'
}

export function Timeline({ entries, running, actions, agent }: { entries: readonly Entry[]; running: boolean; actions: TimelineActions; agent?: TimelineAgent | undefined }) {
  const lastUser = findLastUser(entries)
  return (
    <div className="timeline">
      {entries.map((entry, index) => {
        switch (entry.kind) {
          case 'user':
            return (
              <UserMessage
                key={entry.id}
                entry={entry}
                editable={!running && !entry.local && Boolean(actions.onEdit)}
                isLast={entry.id === lastUser}
                actions={actions}
              />
            )
          case 'agent':
            return <AgentTurn key={entry.id} entry={entry} live={running && index === entries.length - 1} actions={actions} agent={agent} />
          case 'compaction':
            return <CompactionMarker key={entry.id} summary={entry.summary} tokensBefore={entry.tokensBefore} />
          case 'slash':
            return (
              <div key={entry.id} className="slash-result">
                <div className="slash-result-head">
                  <span className="kbd-like">{entry.command}</span>
                  {entry.args.length > 0 && <span className="slash-args">{entry.args.join(' ')}</span>}
                </div>
                {entry.result.kind === 'text'
                  ? <Markdown text={entry.result.text} />
                  : <CodeBlock code={stringify(entry.result.value)} language="json" />}
              </div>
            )
        }
      })}
    </div>
  )
}

function findLastUser(entries: readonly Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry?.kind === 'user') return entry.id
  }
  return undefined
}

// ---------------------------------------------------------------------------

const UserMessage = memo(function UserMessage({
  entry,
  editable,
  isLast,
  actions,
}: {
  entry: Extract<Entry, { kind: 'user' }>
  editable: boolean
  isLast: boolean
  actions: TimelineActions
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.text)
  const [copied, copy] = useCopy()

  if (editing) {
    const submit = () => {
      const text = draft.trim()
      if (!text) return
      setEditing(false)
      actions.onEdit?.(entry.id, text)
    }
    return (
      <div className="user-row">
        <div className="user-edit">
          <textarea
            value={draft}
            autoFocus
            rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
              if (event.key === 'Escape') setEditing(false)
            }}
          />
          <div className="user-edit-footer">
            <span className="muted small">Everything after this message will be replaced.</span>
            <button type="button" className="button ghost small" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="button primary small" onClick={submit} disabled={!draft.trim()}>Send</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="user-row">
      <div className="user-bubble">{entry.text}</div>
      <div className="row-actions">
        <IconAction label={copied ? 'Copied' : 'Copy'} onClick={() => copy(entry.text)}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </IconAction>
        {editable && (
          <IconAction label="Edit and resend" onClick={() => { setDraft(entry.text); setEditing(true) }}>
            <Pencil size={14} />
          </IconAction>
        )}
        {editable && isLast && actions.onRetry && (
          <IconAction label="Retry" onClick={() => actions.onRetry?.(entry.id, entry.text)}>
            <RotateCcw size={14} />
          </IconAction>
        )}
      </div>
    </div>
  )
})

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="icon-button tiny" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------

type Segment =
  | { kind: 'tools'; id: string; tools: ToolView[] }
  | Exclude<Block, { kind: 'tool' }>

function segment(blocks: readonly Block[]): Segment[] {
  const out: Segment[] = []
  for (const block of blocks) {
    if (block.kind === 'tool') {
      const last = out.at(-1)
      if (last?.kind === 'tools') last.tools.push(block.tool)
      else out.push({ kind: 'tools', id: block.id, tools: [block.tool] })
    } else {
      out.push(block)
    }
  }
  return out
}

const AgentTurn = memo(function AgentTurn({
  entry,
  live,
  actions,
  agent,
}: {
  entry: Extract<Entry, { kind: 'agent' }>
  live: boolean
  actions: TimelineActions
  agent?: TimelineAgent | undefined
}) {
  const presentation = live ? { process: [], visible: entry.blocks } : presentRun(entry)
  const segments = segment(presentation.visible)
  const [processOpen, setProcessOpen] = useState(false)
  const [copied, copy] = useCopy()
  const text = entry.blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n\n')
  const last = entry.blocks.at(-1)
  const busyTool = entry.blocks.some(b => b.kind === 'tool' && b.tool.status === 'running')
  const thinking = live && !busyTool && !(last?.kind === 'text' && last.streaming)

  const renderSegment = (seg: Segment) => {
    switch (seg.kind) {
      case 'text':
        return (
          <div key={seg.id} className={seg.streaming ? 'streaming' : undefined}>
            <Markdown text={seg.text} />
          </div>
        )
      case 'tools':
        return <ToolGroup key={seg.id} tools={seg.tools} live={live} />
      case 'subagent':
        return <SubagentCard key={seg.id} agent={seg.agent} onOpen={actions.onOpenSubagent} />
      case 'files':
        return <EditedFiles key={seg.id} files={seg.files} />
      case 'notice':
        return <Notice key={seg.id} tone={seg.tone} text={seg.text} />
    }
  }

  return (
    <div className={`agent-turn${live ? ' is-live' : ''}`}>
      <div className="agent-avatar" aria-hidden>
        {agent ? <AgentAvatar id={agent.id} role={agent.role ?? 'agent'} size={26} live={live} /> : <span className="brand-mark small" />}
      </div>
      <div className="agent-body">
        {presentation.process.length > 0 && (
          <div className={`tool-group${processOpen ? ' open' : ''}`}>
            <button type="button" className="tool-group-head" onClick={() => setProcessOpen(value => !value)} aria-expanded={processOpen}>
              <span className="tool-icon"><Layers size={14} /></span>
              <span className="tool-group-title">Completed process</span>
              <span className="tool-group-summary" />
              <ChevronRight size={14} className="chevron" />
            </button>
            {processOpen && <div className="tool-group-list run-process-list">{segment(presentation.process).map(renderSegment)}</div>}
          </div>
        )}
        {segments.map(renderSegment)}
        {thinking && <ThinkingLine hasContent={entry.blocks.length > 0} />}
        {!live && (text || entry.forkId) && (
          <div className="turn-actions">
            {text && (
              <IconAction label={copied ? 'Copied' : 'Copy response'} onClick={() => copy(text)}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </IconAction>
            )}
            {entry.forkId && actions.onFork && (
              <IconAction label="Fork conversation from here" onClick={() => actions.onFork?.(entry.forkId!)}>
                <GitBranch size={14} />
              </IconAction>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

function ThinkingLine({ hasContent }: { hasContent: boolean }) {
  return (
    <div className="thinking" role="status">
      <span className="thinking-dots" aria-hidden><i /><i /><i /></span>
      <span className="shimmer">{hasContent ? 'Working' : 'Thinking'}</span>
    </div>
  )
}

function Notice({ tone, text }: { tone: 'info' | 'warn' | 'error'; text: string }) {
  const Icon = tone === 'info' ? Info : AlertTriangle
  return (
    <div className={`notice notice-${tone}`}>
      <Icon size={14} />
      <span>{text}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------

const FAMILY_ICON: Record<ToolFamily, typeof Wrench> = {
  read: FileText,
  write: FilePen,
  search: Search,
  shell: SquareTerminal,
  web: Globe,
  agent: Network,
  memory: Brain,
  other: Wrench,
}

const FAMILY_NOUN: Record<ToolFamily, [string, string]> = {
  read: ['read', 'reads'],
  write: ['edit', 'edits'],
  search: ['search', 'searches'],
  shell: ['command', 'commands'],
  web: ['web request', 'web requests'],
  agent: ['agent call', 'agent calls'],
  memory: ['memory update', 'memory updates'],
  other: ['tool call', 'tool calls'],
}

function ToolGroup({ tools, live }: { tools: ToolView[]; live: boolean }) {
  const running = tools.some(t => t.status === 'running')
  const failed = tools.filter(t => t.status === 'error').length
  const [open, setOpen] = useState<boolean | undefined>(undefined)
  if (tools.length === 1) return <div className="tool-group single"><ToolRow tool={tools[0]!} /></div>
  const expanded = open ?? (live && running)

  const counts = new Map<ToolFamily, number>()
  for (const tool of tools) {
    const family = presentTool(tool).family
    counts.set(family, (counts.get(family) ?? 0) + 1)
  }
  const summary = [...counts].map(([family, n]) => `${n} ${FAMILY_NOUN[family][n === 1 ? 0 : 1]}`).join(', ')

  return (
    <div className={`tool-group${expanded ? ' open' : ''}`}>
      <button type="button" className="tool-group-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <span className="tool-icon"><Layers size={14} /></span>
        <span className="tool-group-title">{running ? 'Working through' : 'Used'} {tools.length} steps</span>
        <span className="tool-group-summary">{summary}</span>
        {failed > 0 && <span className="pill pill-danger">{failed} failed</span>}
        {running ? <span className="spinner" aria-label="Running" /> : null}
        <ChevronRight size={14} className="chevron" />
      </button>
      {expanded && (
        <div className="tool-group-list">
          {tools.map(tool => <ToolRow key={tool.callId} tool={tool} />)}
        </div>
      )}
    </div>
  )
}

function ToolRow({ tool }: { tool: ToolView }) {
  const [open, setOpen] = useState(false)
  const { family, verb, target } = presentTool(tool)
  const Icon = FAMILY_ICON[family]
  return (
    <div className={`tool-row status-${tool.status}${open ? ' open' : ''}`}>
      <button type="button" className="tool-row-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <span className="tool-icon"><Icon size={14} /></span>
        <span className="tool-verb">{verb}</span>
        {target && <span className="tool-target">{target}</span>}
        {tool.children?.length ? <span className="tool-group-summary">{tool.children.length} tool {tool.children.length === 1 ? 'call' : 'calls'}</span> : null}
        <span className="tool-meta">
          {tool.status === 'running' && <span className="spinner" aria-label="Running" />}
          {tool.status === 'error' && <X size={13} className="tool-status-error" aria-label="Failed" />}
          {tool.status === 'ok' && tool.durationMs !== undefined && <span className="tool-duration">{formatDuration(tool.durationMs)}</span>}
        </span>
        <ChevronRight size={14} className="chevron" />
      </button>
      {open && <ToolDetail tool={tool} />}
    </div>
  )
}

function ToolDetail({ tool }: { tool: ToolView }) {
  const args = tool.args
  const command = args && typeof args === 'object' && typeof (args as Record<string, unknown>).command === 'string'
    ? (args as Record<string, string>).command
    : undefined
  const output = readableOutput(tool.output)
  return (
    <div className="tool-detail">
      <div className="tool-detail-label">{tool.name}</div>
      {command !== undefined
        ? <CodeBlock code={command} language="shell" />
        : args !== undefined && <CodeBlock code={stringify(args)} language="json" />}
      {tool.error && (
        <>
          <div className="tool-detail-label danger">Error</div>
          <pre className="tool-output error">{tool.error}</pre>
        </>
      )}
      {output.text && (
        <>
          <div className="tool-detail-label">Output</div>
          <pre className="tool-output">{output.text}</pre>
        </>
      )}
      {tool.status === 'running' && <div className="muted small">Waiting for result…</div>}
      {tool.children?.length ? (
        <div className="ptc-tool-children">
          <div className="tool-detail-label">Tool calls</div>
          {tool.children.map(child => <ToolRow key={child.callId} tool={child} />)}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------

const SUBAGENT_STATUS: Record<SubagentView['status'], { label: string; tone: string }> = {
  starting: { label: 'Starting', tone: 'running' },
  running: { label: 'Running', tone: 'running' },
  ready: { label: 'Finished', tone: 'ok' },
  failed: { label: 'Failed', tone: 'error' },
}

function SubagentCard({ agent, onOpen }: { agent: SubagentView; onOpen?: ((id: string, label: string) => void) | undefined }) {
  const status = SUBAGENT_STATUS[agent.status]
  const latest = agent.replies.at(-1)
  return (
    <div className="subagent-card">
      <div className="subagent-head">
        <AgentAvatar id={agent.id ?? agent.callId ?? agent.label} size={32} live={agent.status === 'running' || agent.status === 'starting'} />
        <div className="subagent-titles">
          <div className="subagent-label">{agent.label}</div>
          <div className="subagent-sub">{agent.mode === 'fork' ? 'Forked subagent' : 'Subagent'}</div>
        </div>
        <span className={`status-pill tone-${status.tone}`}>
          {status.tone === 'running' ? <span className="spinner tiny" /> : <span className="dot" />}
          {status.label}
        </span>
      </div>
      {agent.task && agent.task !== agent.label && <p className="subagent-task">{agent.task}</p>}
      {agent.error && <Notice tone="error" text={agent.error} />}
      {latest && (
        <div className="subagent-reply">
          <Markdown text={latest.length > 1200 ? `${latest.slice(0, 1200)}…` : latest} />
        </div>
      )}
      {agent.id && onOpen && (
        <button type="button" className="link-button" onClick={() => onOpen(agent.id!, agent.label)}>
          Open transcript <ChevronRight size={13} />
        </button>
      )}
    </div>
  )
}

function EditedFiles({ files }: { files: Array<{ path: string; additions?: number; deletions?: number }> }) {
  return (
    <div className="files-card">
      <div className="files-head">
        <FilePen size={14} />
        <span>{files.length === 1 ? '1 file changed' : `${files.length} files changed`}</span>
      </div>
      <ul className="files-list">
        {files.map(file => (
          <li key={file.path}>
            <span className="files-path">{file.path}</span>
            {file.additions !== undefined && <span className="diff-add">+{file.additions}</span>}
            {file.deletions !== undefined && <span className="diff-del">−{file.deletions}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function CompactionMarker({ summary, tokensBefore }: { summary: string; tokensBefore?: number | undefined }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="compaction">
      <button type="button" className="compaction-rule" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <span className="compaction-line" />
        <span className="compaction-label">
          Context compacted{tokensBefore ? ` · ${formatTokens(tokensBefore)} tokens summarized` : ''}
          <ChevronRight size={13} className={`chevron${open ? ' rotated' : ''}`} />
        </span>
        <span className="compaction-line" />
      </button>
      {open && summary && <div className="compaction-summary"><Markdown text={summary} /></div>}
    </div>
  )
}
