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
  SquareMousePointer,
} from 'lucide-react'
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { turnWeather } from '../lib/weather'
import { useCopy } from '../lib/hooks'
import type { Block, Entry, SubagentView, ToolView } from '../lib/timeline'
import { formatDuration, formatTokens, presentOutcome, presentRun, stringify } from '../lib/timeline'
import { officeFiles } from '../lib/office'
import { codeModeOutput, needsAttention, presentTool, readableOutput, type ToolFamily } from '../lib/tools'
import { AgentAvatar } from './AgentAvatar'
import { ImageStrip } from './ImageStrip'
import { splitPickedContext } from '../lib/browser-live'
import { CodeBlock, Markdown } from './Markdown'
import { OfficeFiles } from './OfficeFiles'

export interface TimelineActions {
  onEdit?: (entryId: string, text: string) => void
  onRetry?: (entryId: string, text: string) => void
  onFork?: (messageId: string) => void
  onOpenSubagent?: (id: string, label: string) => void
  onOpenFile?: (path: string) => void
  /** Show a file this turn changed in the Workbench diff. */
  onOpenChange?: (path: string) => void
}

/** Whose avatar the agent turns in this timeline wear. */
export interface TimelineAgent {
  id: string
  role?: 'coordinator' | 'agent'
}

/** Signals beyond the entries that shape the latest turn's weather. */
export interface TimelineSky {
  /** An approval or question is waiting on the user. */
  waiting?: boolean
  /** Share of the context window in use, 0–1. */
  contextRatio?: number
}

export function Timeline({ entries, running, actions, agent, sky, outcomeFirst = false }: {
  entries: readonly Entry[]
  running: boolean
  actions: TimelineActions
  agent?: TimelineAgent | undefined
  sky?: TimelineSky | undefined
  /** Show each turn's answer and fold its steps (project threads). */
  outcomeFirst?: boolean
}) {
  const lastAgent = findLastAgent(entries)
  // Tracked here, not per turn: the finished turn is re-keyed when durable events reload.
  const justFinished = useJustFinished(running)
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
            return <AgentTurn key={entry.id} entry={entry} live={running && index === entries.length - 1} actions={actions} agent={agent} sky={entry.id === lastAgent ? sky : undefined} latest={entry.id === lastAgent} justFinished={entry.id === lastAgent && justFinished} outcomeFirst={outcomeFirst} />
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
  const picked = splitPickedContext(entry.text)

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
      {entry.images?.length ? <ImageStrip images={entry.images} className="user-images" /> : null}
      {picked.contexts.length > 0 && (
        <div className="user-contexts">
          {picked.contexts.map((context, index) => (
            <span key={index} className="composer-context" title={context.text}>
              <SquareMousePointer size={13} aria-hidden />
              <span className="composer-context-label">{context.label}</span>
            </span>
          ))}
        </div>
      )}
      {picked.rest && <div className="user-bubble">{picked.rest}</div>}
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

function findLastAgent(entries: readonly Entry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.kind === 'agent') return entry.id
  }
  return undefined
}

/** True for a few seconds after a run stops. */
function useJustFinished(running: boolean): boolean {
  const wasRunning = useRef(running)
  const [fresh, setFresh] = useState(false)
  useEffect(() => {
    const finished = wasRunning.current && !running
    wasRunning.current = running
    if (!finished) return
    setFresh(true)
    const timer = setTimeout(() => setFresh(false), 3_200)
    return () => clearTimeout(timer)
  }, [running])
  return fresh
}

const AgentTurn = memo(function AgentTurn({
  entry,
  live,
  actions,
  agent,
  sky,
  latest = false,
  justFinished = false,
  outcomeFirst = false,
}: {
  entry: Extract<Entry, { kind: 'agent' }>
  live: boolean
  actions: TimelineActions
  agent?: TimelineAgent | undefined
  sky?: TimelineSky | undefined
  /** The newest reply keeps its actions in view; older ones show them on hover. */
  latest?: boolean
  justFinished?: boolean
  outcomeFirst?: boolean
}) {
  const weather = sky || live || justFinished || entry.status === 'error'
    ? turnWeather(entry, { live, justFinished, ...(sky?.waiting ? { waiting: true } : {}), ...(sky?.contextRatio !== undefined ? { contextRatio: sky.contextRatio } : {}) })
    : undefined
  const presentation = outcomeFirst ? presentOutcome(entry, live) : live ? { process: [], visible: entry.blocks } : presentRun(entry)
  const segments = segment(presentation.visible)
  const [processOpen, setProcessOpen] = useState(false)
  const [copied, copy] = useCopy()
  const text = entry.blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n\n')
  const last = entry.blocks.at(-1)
  const busyTool = entry.blocks.some(b => b.kind === 'tool' && b.tool.status === 'running')
  const thinking = live && (outcomeFirst || (!busyTool && !(last?.kind === 'text' && last.streaming)))
  // Produced files stay visible even when the tools that wrote them fold into the process.
  const files = live ? [] : officeFiles(entry.blocks)

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
        return <EditedFiles key={seg.id} files={seg.files} onOpen={actions.onOpenChange} />
      case 'notice':
        return <Notice key={seg.id} tone={seg.tone} text={seg.text} />
    }
  }

  return (
    <div className={`agent-turn${live ? ' is-live' : ''}${latest ? ' is-latest' : ''}`}>
      <div className="agent-avatar" aria-hidden>
        {agent
          ? <AgentAvatar id={agent.id} role={agent.role ?? 'agent'} size={26} live={live} weather={weather === 'clear' && !live ? undefined : weather} title={agent.role === 'coordinator' ? 'Agent' : undefined} />
          : <span className="brand-mark small" />}
      </div>
      <div className="agent-body">
        {presentation.process.length > 0 && (
          <div className={`tool-group${processOpen ? ' open' : ''}`}>
            <button type="button" className="tool-group-head" onClick={() => setProcessOpen(value => !value)} aria-expanded={processOpen}>
              <span className="tool-icon"><Layers size={14} /></span>
              <span className="tool-group-title">{outcomeFirst ? `${live ? 'Working through' : 'Show'} ${presentation.process.length} step${presentation.process.length === 1 ? '' : 's'}` : 'Completed process'}</span>
              <span className="tool-group-summary" />
              <ChevronRight size={14} className="chevron" />
            </button>
            {processOpen && <div className="tool-group-list run-process-list">{segment(presentation.process).map(renderSegment)}</div>}
          </div>
        )}
        {segments.map(renderSegment)}
        {files.length > 0 && <OfficeFiles files={files} onOpen={actions.onOpenFile} />}
        {thinking && <ThinkingLine hasContent={entry.blocks.length > 0} />}
        {!live && (text || entry.forkId) && (
          <div className="turn-actions">
            {text && (
              <IconAction label={copied ? 'Copied' : 'Copy response'} onClick={() => copy(text)}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </IconAction>
            )}
            {entry.forkId && actions.onFork && (
              <button
                type="button"
                className="turn-action-fork"
                title="Start a new session that continues from this reply"
                onClick={() => actions.onFork?.(entry.forkId!)}
              >
                <GitBranch size={13} />Fork from here
              </button>
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
  const failed = tools.filter(needsAttention).length
  const [open, setOpen] = useState<boolean | undefined>(undefined)
  // While the turn streams, calls are plain rows: a folder that opens for each
  // running call and shuts between them flickers. It folds once, at the end.
  if (tools.length === 1 || (live && open === undefined)) {
    return <div className="tool-group single">{tools.map(tool => <ToolRow key={tool.callId} tool={tool} />)}</div>
  }
  const expanded = open ?? false

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
  const [open, setOpen] = useState<boolean | undefined>(undefined)
  const expanded = open ?? (tool.name === 'run_code' && tool.status === 'running')
  const { family, verb, target } = presentTool(tool)
  const children = tool.children ?? []
  const running = children.filter(child => child.status === 'running').length
  const failed = children.filter(needsAttention).length
  const completed = children.filter(child => child.status !== 'running').length
  const attention = needsAttention(tool)
  // A model-facing error looks like any finished call; its detail still shows the message.
  const status = tool.status === 'error' && !attention ? 'note' : tool.status
  const Icon = FAMILY_ICON[family]
  return (
    <div className={`tool-row status-${status}${expanded ? ' open' : ''}`}>
      <button type="button" className="tool-row-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded} aria-label={`${verb}${target ? ` ${target}` : ''}${children.length ? `, ${children.length} tool calls, ${completed} done, ${running} running, ${failed} failed` : ''}${tool.status === 'running' ? ', Running' : attention ? ', Failed' : status === 'note' ? ', Returned an error to the agent' : ''}`}>
        <span className="tool-icon"><Icon size={14} /></span>
        <span className="tool-verb">{verb}</span>
        {target && <span className="tool-target">{target}</span>}
        {children.length ? <span className="tool-group-summary">{children.length} tool {children.length === 1 ? 'call' : 'calls'} · {completed} done{running ? ` · ${running} running` : ''}{failed ? ` · ${failed} failed` : ''}</span> : null}
        <span className="tool-meta">
          {tool.status === 'running' && <span className="spinner" aria-label="Running" />}
          {attention && <X size={13} className="tool-status-error" aria-label="Failed" />}
          {!attention && tool.status !== 'running' && tool.durationMs !== undefined && <span className="tool-duration">{formatDuration(tool.durationMs)}</span>}
        </span>
        <ChevronRight size={14} className="chevron" />
      </button>
      {expanded && <ToolDetail tool={tool} />}
    </div>
  )
}

function ToolDetail({ tool }: { tool: ToolView }) {
  const args = tool.args
  const code = tool.name === 'run_code' && args && typeof args === 'object' && 'code' in args && typeof args.code === 'string'
    ? args.code : undefined
  const command = args && typeof args === 'object' && typeof (args as Record<string, unknown>).command === 'string'
    ? (args as Record<string, string>).command
    : undefined
  const output = readableOutput(tool.output)
  const codeOutput = tool.name === 'run_code' ? codeModeOutput(tool.output) : undefined
  return (
    <div className="tool-detail">
      <div className="tool-detail-label">{tool.name}</div>
      {code !== undefined
        ? <CodeBlock code={code} language="javascript" />
        : command !== undefined
        ? <CodeBlock code={command} language="shell" />
        : args !== undefined && <CodeBlock code={stringify(args)} language="json" />}
      {tool.error && (needsAttention(tool) ? (
        <>
          <div className="tool-detail-label danger">Error</div>
          <pre className="tool-output error">{tool.error}</pre>
        </>
      ) : (
        <>
          <div className="tool-detail-label">Returned to the agent</div>
          <pre className="tool-output">{tool.error}</pre>
        </>
      ))}
      {codeOutput && codeOutput.blocks.length > 0 && (
        <>
          <div className="tool-detail-label">Output</div>
          {codeOutput.blocks.map((text, index) => <pre key={index} className="tool-output ptc-output-block">{text}</pre>)}
        </>
      )}
      {codeOutput?.value !== undefined && (
        <>
          <div className="tool-detail-label">Return value</div>
          <pre className="tool-output">{readableOutput(codeOutput.value).text}</pre>
        </>
      )}
      {!codeOutput && output.text && (
        <>
          <div className="tool-detail-label">Output</div>
          <pre className="tool-output">{output.text}</pre>
        </>
      )}
      {tool.images?.length ? (
        <>
          <div className="tool-detail-label">Images</div>
          <ImageStrip images={tool.images} />
        </>
      ) : null}
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
        <AgentAvatar
          id={agent.id ?? agent.callId ?? agent.label}
          size={32}
          live={agent.status === 'running' || agent.status === 'starting'}
          weather={agent.status === 'starting' ? 'sprite' : agent.status === 'running' ? 'drizzle' : agent.status === 'failed' ? 'storm' : undefined}
        />
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

function EditedFiles({ files, onOpen }: { files: Array<{ path: string; additions?: number; deletions?: number }>; onOpen?: ((path: string) => void) | undefined }) {
  return (
    <div className="files-card">
      <div className="files-head">
        <FilePen size={14} />
        <span>{files.length === 1 ? '1 file changed' : `${files.length} files changed`}</span>
      </div>
      <ul className="files-list">
        {files.map(file => {
          const body = (
            <>
              <span className="files-path">{file.path}</span>
              {file.additions !== undefined && <span className="diff-add">+{file.additions}</span>}
              {file.deletions !== undefined && <span className="diff-del">−{file.deletions}</span>}
            </>
          )
          return (
            <li key={file.path}>
              {onOpen
                ? <button type="button" className="files-row" title={`Show the diff of ${file.path}`} onClick={() => onOpen(file.path)}>{body}</button>
                : body}
            </li>
          )
        })}
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
