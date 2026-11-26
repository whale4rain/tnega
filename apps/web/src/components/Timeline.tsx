import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  FileText,
  GitBranch,
  Info,
  Layers,
  Lightbulb,
  SlidersHorizontal,
  Pencil,
  RotateCcw,
  SquareMousePointer,
  MousePointerClick,
} from 'lucide-react'
import { memo, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Choice, type ChoiceOption } from './Menu'
import { turnWeather } from '../lib/weather'
import { useCopy } from '../lib/hooks'
import type { ProcessView } from '../lib/process-view'
import type { Block, Entry, SubagentView, ToolView } from '../lib/timeline'
import { formatDuration, formatTokens, presentLive, presentOutcome, presentRun, stringify } from '../lib/timeline'
import { officeFiles } from '../lib/office'
import { settleMarkdown, useSmoothText } from '../lib/streaming'
import { codeModeOutput, needsAttention, presentTool, readableOutput, summarizeSteps } from '../lib/tools'
import { AgentAvatar } from './AgentAvatar'
import { PenMark, type PenKind } from './PenMark'
import { ImageStrip } from './ImageStrip'
import { splitPickedContext } from '../lib/browser-live'
import { fileName, splitAttachedFiles } from '../lib/attached-files'
import { LinkContext } from '../lib/links'
import { CodeBlock, Markdown } from './Markdown'
import { OfficeFiles } from './OfficeFiles'
import { ReplyOutputs } from './ReplyOutputs'
import { isReplyTool, parseAction, replyItems, type A2uiAction } from '../lib/reply'
import { useFileMenu } from './FileMenu'

export interface TimelineActions {
  onEdit?: (entryId: string, text: string) => void
  onRetry?: (entryId: string, text: string) => void
  onFork?: (messageId: string) => void
  onOpenSubagent?: (id: string, label: string) => void
  onOpenFile?: (path: string) => void
  /** Show a file this turn changed in the Workbench diff. */
  onOpenChange?: (path: string) => void
  /** Send what a person did on an agent-rendered form, as their next message. */
  onUiAction?: (text: string) => void
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

/**
 * Memoized, like each turn in it: a long session renders hundreds of turns, and
 * a parent re-render that changes none of these props (a scroll, a keystroke,
 * a queue change) must not walk them again. Pass stable `actions`, `agent` and
 * `sky` objects for this to hold.
 */
export const Timeline = memo(function Timeline({ entries, running, actions, agent, sky, outcomeFirst = false, processView = 'steps', onProcessViewChange }: {
  entries: readonly Entry[]
  running: boolean
  actions: TimelineActions
  agent?: TimelineAgent | undefined
  sky?: TimelineSky | undefined
  /** Show each turn's answer and fold its steps (project threads). */
  outcomeFirst?: boolean
  /** While a turn streams: every step as it happens, or one progress line until the answer. */
  processView?: ProcessView
  /** Present when the live turn offers the switch at its foot. */
  onProcessViewChange?: ((value: ProcessView) => void) | undefined
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
          case 'agent': {
            const next = entries[index + 1]
            // A form in this turn was answered by the message after it, or still waits when nothing came after.
            const answer = next?.kind === 'user' && parseAction(next.text) ? next.text : undefined
            return <AgentTurn key={entry.id} entry={entry} live={running && index === entries.length - 1} actions={actions} agent={agent} sky={entry.id === lastAgent ? sky : undefined} latest={entry.id === lastAgent} justFinished={entry.id === lastAgent && justFinished} outcomeFirst={outcomeFirst} processView={processView} onProcessViewChange={onProcessViewChange} answerable={!running && index === entries.length - 1} answer={answer} />
          }
          case 'compaction':
            return <CompactionMarker key={entry.id} summary={entry.summary} tokensBefore={entry.tokensBefore} />
          case 'setting':
            return <SettingChange key={entry.id} text={entry.text} />
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
})

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
  const attached = splitAttachedFiles(picked.rest)
  const links = useContext(LinkContext)
  const action = parseAction(entry.text)

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
              <SquareMousePointer size={12} aria-hidden />
              <span className="composer-context-label">{context.label}</span>
            </span>
          ))}
        </div>
      )}
      {attached.paths.length > 0 && (
        <div className="user-contexts">
          {attached.paths.map((path, index) => (
            <AttachedFileChip key={index} path={path} {...(links.openPath ? { onOpen: links.openPath } : {})} />
          ))}
        </div>
      )}
      {action
        ? <UiActionBubble action={action} />
        : attached.rest && <div className="user-bubble"><Markdown text={attached.rest} breaks /></div>}
      <div className="row-actions">
        <IconAction label={copied ? 'Copied' : 'Copy'} onClick={() => copy(entry.text)}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </IconAction>
        {editable && !action && (
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

/** A button pressed on an agent's form: what was pressed, then the values sent with it. */
function UiActionBubble({ action }: { action: A2uiAction }) {
  const values = Object.entries(action.values).flatMap(([key, value]) => {
    const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : Array.isArray(value) ? value.join(', ') : value
    return text ? [[key, text] as const] : []
  })
  return (
    <div className="user-bubble ui-action-bubble">
      <div className="ui-action-label"><MousePointerClick size={12} aria-hidden />{action.label}</div>
      {values.length > 0 && (
        <dl className="ui-action-values">
          {values.map(([key, text]) => (
            <div key={key}><dt>{key}</dt><dd>{text}</dd></div>
          ))}
        </dl>
      )}
    </div>
  )
}

/** A file sent with the message: its name, and a click opens it in the Workbench. */
function AttachedFileChip({ path, onOpen }: { path: string; onOpen?: (path: string) => void }) {
  const name = fileName(path)
  const content = (
    <>
      <FileText size={12} aria-hidden />
      <span className="composer-context-label">{name}</span>
    </>
  )
  if (!onOpen) return <span className="composer-context composer-file" title={path}>{content}</span>
  return (
    <button type="button" className="composer-context composer-file" title={path} aria-label={`Open ${name}`} onClick={() => onOpen(path)}>
      {content}
    </button>
  )
}

/** A turn action: a round 32 button under the turn, shown on hover or keyboard focus (Umbrella conversation.md). */
function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="turn-action" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------

/** A thought or a tool call: the steps an agent takes between the words it says. */
type Step = Extract<Block, { kind: 'tool' | 'reasoning' }>

type Segment =
  | { kind: 'steps'; id: string; steps: Step[] }
  | Exclude<Block, { kind: 'tool' }>

/**
 * Consecutive thoughts and tool calls fold into one run of steps, so the
 * transcript reads as words and one quiet line between them (tnega-design
 * §5.1). A thought still being written stays on its own line so it can be
 * read as it streams; a run of one thought is just that thought.
 * `fold: 'tools'` keeps each thought on its own line and folds only the tool
 * calls between them; `fold: 'none'` lists every step (see `processSegments`).
 */
function segment(blocks: readonly Block[], { fold = 'steps' }: { fold?: 'steps' | 'tools' | 'none' } = {}): Segment[] {
  const out: Segment[] = []
  let run: Step[] = []
  const flush = () => {
    const only = run.length === 1 ? run[0] : undefined
    if (only?.kind === 'reasoning') out.push(only)
    else if (run.length) out.push({ kind: 'steps', id: run[0]!.id, steps: run })
    run = []
  }
  for (const block of blocks) {
    if (block.kind === 'tool' || (fold === 'steps' && block.kind === 'reasoning' && !block.streaming)) {
      run.push(block)
      if (fold === 'none') flush()
    } else {
      flush()
      out.push(block)
    }
  }
  flush()
  return out
}

/**
 * What an opened process fold lists. Narration stays as written and each run
 * of thoughts and tool calls between it folds to one line again, so a long
 * process reads as a few lines. A process that is one run already sits behind
 * the fold's own line, so opening it shows its thoughts, with the tool calls
 * between two thoughts folded to one line ("Read 2 files, ran a command").
 * Folding that to one line again would only add a click, so then every step
 * is listed.
 */
function processSegments(blocks: readonly Block[]): Segment[] {
  const single = (segments: Segment[]) => segments.length === 1 && segments[0]?.kind === 'steps'
  const folded = segment(blocks)
  if (!single(folded)) return folded
  const tools = segment(blocks, { fold: 'tools' })
  return single(tools) ? segment(blocks, { fold: 'none' }) : tools
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
  processView = 'steps',
  onProcessViewChange,
  answerable = false,
  answer,
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
  /** While the turn streams: every step, or one progress line (see `Timeline`). */
  processView?: ProcessView
  onProcessViewChange?: ((value: ProcessView) => void) | undefined
  /** The newest turn with nothing after it: a form it showed still takes an answer. */
  answerable?: boolean
  /** The user message right after this turn, when it answered one of its forms. */
  answer?: string | undefined
}) {
  const weather = sky || live || justFinished || entry.status === 'error'
    ? turnWeather(entry, { live, justFinished, ...(sky?.waiting ? { waiting: true } : {}), ...(sky?.contextRatio !== undefined ? { contextRatio: sky.contextRatio } : {}) })
    : undefined
  // Sent files and forms are part of the answer, not steps: they show under it.
  const replies = replyItems(entry.blocks)
  const shown = replies.length ? { ...entry, blocks: entry.blocks.filter(block => !(block.kind === 'tool' && isReplyTool(block.tool))) } : entry
  const presentation = present(shown, live, outcomeFirst, processView)
  const segments = segment(presentation.visible)
  const [processOpen, setProcessOpen] = useState(false)
  const [copied, copy] = useCopy()
  const text = entry.blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n\n')
  const last = entry.blocks.at(-1)
  // A running step or reply text already shows activity; otherwise say the model is working. Text
  // that just finished counts too: a "Working" line flashing under the answer in the moment before the
  // run ends only made the transcript jump.
  const thinking = live && presentation.process.length === 0
    && last?.kind !== 'text'
    && !(last?.kind === 'tool' && last.tool.status === 'running')
    && !(last?.kind === 'subagent' && (last.agent.status === 'running' || last.agent.status === 'starting'))
  // Produced files stay visible even when the tools that wrote them fold into the process.
  const files = live ? [] : officeFiles(entry.blocks)

  const renderSegment = (seg: Segment) => {
    switch (seg.kind) {
      case 'text':
        return (
          seg.streaming && live
            ? <StreamingText key={seg.id} text={seg.text} />
            : <div key={seg.id}><Markdown text={seg.text} /></div>
        )
      case 'steps':
        return <StepGroup key={seg.id} steps={seg.steps} live={live} />
      case 'subagent':
        return <SubagentCard key={seg.id} agent={seg.agent} onOpen={actions.onOpenSubagent} />
      case 'files':
        return <EditedFiles key={seg.id} files={seg.files} onOpen={actions.onOpenChange} />
      case 'notice':
        return <Notice key={seg.id} tone={seg.tone} text={seg.text} />
      case 'setting':
        return <SettingLine key={seg.id} text={seg.text} />
      case 'reasoning':
        return <Thought key={seg.id} text={seg.text} streaming={live && seg.streaming === true} {...(seg.durationMs !== undefined ? { durationMs: seg.durationMs } : {})} />
    }
  }

  return (
    <div className={`agent-turn turn${live ? ' is-live' : ''}${latest ? ' is-latest' : ''}`}>
      {/* The umbrella disc says who is speaking, once per turn; a subagent's transcript wears its own avatar. */}
      <div className="agent-avatar turn-disc" aria-hidden>
        <AgentAvatar
          id={agent?.id ?? 'main'}
          role={agent ? agent.role ?? 'agent' : 'coordinator'}
          size={26}
          live={live}
          weather={weather === 'clear' && !live ? undefined : weather}
          {...(agent?.role === 'coordinator' || !agent ? { title: 'Agent' } : {})}
        />
      </div>
      <div className="agent-body">
        {presentation.process.length > 0 && (
          <div className={`tool-group process${processOpen ? ' open' : ''}${live ? ' is-live' : ''}`}>
            <ProcessHead blocks={presentation.process} live={live} open={processOpen} onToggle={() => setProcessOpen(value => !value)} />
            {processOpen && <div className="tool-group-list run-process-list">{processSegments(presentation.process).map(renderSegment)}</div>}
          </div>
        )}
        {segments.map(renderSegment)}
        {replies.length > 0 && <ReplyOutputs items={replies} onOpen={actions.onOpenFile} answerable={answerable} answer={answer} onAction={actions.onUiAction} />}
        {files.length > 0 && <OfficeFiles files={files} onOpen={actions.onOpenFile} />}
        {thinking && <ThinkingLine hasContent={entry.blocks.length > 0} />}
        {live && onProcessViewChange && (
          <div className="turn-process">
            <span className="turn-process-label">Process output</span>
            <Choice
              label="Process output"
              value={processView}
              options={PROCESS_VIEW_OPTIONS}
              onChange={onProcessViewChange}
              icon={<Layers size={12} />}
              side="top"
            />
          </div>
        )}
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
                className="turn-action turn-action-fork"
                title="Start a new session that continues from this reply"
                onClick={() => actions.onFork?.(entry.forkId!)}
              >
                <GitBranch size={14} aria-hidden />Fork from here
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

/**
 * Finished turns with a run summary keep it; everything else folds outcome-first.
 * A streaming turn shows its steps, unless the reader asked for the quiet live
 * view: then only the one progress line and the answer's arrival stay in view.
 */
function present(entry: Extract<Entry, { kind: 'agent' }>, live: boolean, outcomeFirst: boolean, processView: ProcessView): { process: Block[]; visible: Block[] } {
  if (outcomeFirst) return presentOutcome(entry, live)
  if (live) return processView === 'answer' ? presentOutcome(entry, true) : presentLive(entry)
  const run = presentRun(entry)
  return run.process.length ? run : presentOutcome(entry, false)
}

/**
 * The one line a folded process shows. While the turn runs it names the
 * current step ("Running npm test"); once done it says what was done, in the
 * same words as any other run of steps ("Read 3 files, ran a command").
 */
function ProcessHead({ blocks, live, open, onToggle }: { blocks: readonly Block[]; live: boolean; open: boolean; onToggle: () => void }) {
  const tools = blocks.flatMap(block => (block.kind === 'tool' ? [block.tool] : []))
  const thoughts = blocks.filter(block => block.kind === 'reasoning').length
  const running = [...tools].reverse().find(tool => tool.status === 'running')
  const current = running ? presentTool(running) : undefined
  const failed = tools.filter(needsAttention).length
  const title = live
    ? current ? `${current.verb}${current.target ? ` ${current.target}` : ''}` : 'Thinking'
    : tools.length ? summarizeSteps(tools) : thoughts ? thoughtTitle(stepsDuration(blocks)) : 'Show details'
  const duration = !live && tools.length ? stepsDuration(blocks) : undefined
  return (
    <button
      type="button"
      className="tool-group-head step-line"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={live ? `Working: ${title}${tools.length ? `, ${tools.length} ${tools.length === 1 ? 'step' : 'steps'} so far` : ''}` : `${title}${failed ? `, ${failed} of ${tools.length} failed` : ''}`}
    >
      <PenMark kind={live ? 'working' : failed ? 'failed' : 'done'} size={16} />
      <span className={`tool-group-title${live ? ' shimmer' : ''}`}>{title}</span>
      {live && tools.length > 1 && <span className="tool-group-summary">· {tools.length} steps</span>}
      <StepTail failed={failed} total={tools.length} duration={duration} />
      <ChevronRight size={14} className="chevron" aria-hidden />
    </button>
  )
}

/** What follows a step line's words: failures written out in --danger, then the time it took. */
function StepTail({ failed, total, duration }: { failed: number; total: number; duration: number | undefined }) {
  return (
    <>
      {failed > 0 && <span className="step-failed">· {total > 1 ? `${failed} of ${total} failed` : 'failed'}</span>}
      {total > 0 && duration !== undefined && <span className="tool-duration">· {formatDuration(duration)}</span>}
    </>
  )
}

/** How long a run of steps took: its tool calls plus its thinking. */
function stepsDuration(blocks: readonly Block[]): number | undefined {
  let total = 0
  let known = false
  for (const block of blocks) {
    const ms = block.kind === 'tool' ? block.tool.durationMs : block.kind === 'reasoning' ? block.durationMs : undefined
    if (ms === undefined) continue
    total += ms
    known = true
  }
  return known ? total : undefined
}

function thoughtTitle(durationMs: number | undefined): string {
  return durationMs !== undefined && durationMs >= 1000 ? `Thought for ${formatDuration(durationMs)}` : 'Thought'
}

/**
 * The live turn's output switch. Steps is what the timeline does by default:
 * narration, thoughts and tool calls stream in as they happen. Answer only
 * keeps the one progress line and shows the answer once the turn ends.
 */
const PROCESS_VIEW_OPTIONS: ReadonlyArray<ChoiceOption<ProcessView>> = [
  { value: 'steps', label: 'Steps', description: 'Stream every step and thought as the agent works' },
  { value: 'answer', label: 'Answer only', description: 'Keep one progress line; the answer appears when the turn ends' },
]

/**
 * The model's visible reasoning. It reads as it is written, then folds to one
 * line ("Thought for 8s") once the answer begins; opening it is a choice.
 */
function Thought({ text, streaming, durationMs }: { text: string; streaming: boolean; durationMs?: number }) {
  const [chosen, setChosen] = useState<boolean | undefined>(undefined)
  const open = chosen ?? streaming
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Follow the newest line while it streams, like a terminal tail.
    if (streaming && open && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [text, streaming, open])
  const title = streaming ? 'Thinking' : thoughtTitle(durationMs)
  return (
    <div className={`thought${open ? ' open' : ''}${streaming ? ' is-live' : ''}`}>
      <button type="button" className="thought-head step-line" aria-expanded={open} onClick={() => setChosen(!open)}>
        <span className="step-mark" aria-hidden><Lightbulb size={14} /></span>
        <span className={`thought-title${streaming ? ' shimmer' : ''}`}>{title}</span>
        <ChevronRight size={14} className="chevron" aria-hidden />
      </button>
      {open && <div ref={body} className={`thought-body${streaming ? ' is-live' : ''}`}>{text}</div>}
    </div>
  )
}

/**
 * A reply that is still arriving (umbrella/conversation.md, Streaming): revealed at an even pace, with
 * half-written Markdown held back until it closes, so no raw `**` or pipes flash on screen.
 */
function StreamingText({ text }: { text: string }) {
  const shown = useSmoothText(text, true)
  return (
    <div className="streaming">
      <Markdown text={settleMarkdown(shown)} />
    </div>
  )
}

function ThinkingLine({ hasContent }: { hasContent: boolean }) {
  return (
    <div className="thinking step-line" role="status">
      <PenMark kind="working" size={16} />
      <span className="shimmer">{hasContent ? 'Working' : 'Thinking'}</span>
    </div>
  )
}

/**
 * Something the agent's run wants you to know (Umbrella asks.md, Notices): one white card, a sunken disc
 * with the subject's icon and a sentence. A failure carries the failed mark instead of the disc; the
 * mark's label says the severity in words.
 */
function Notice({ tone, text }: { tone: 'info' | 'warn' | 'error'; text: string }) {
  const Icon = tone === 'info' ? Info : AlertTriangle
  return (
    <div className={`notice-card is-${tone}`}>
      {tone === 'error'
        ? <span className="notice-lead"><PenMark kind="failed" size={20} label="Failed" /></span>
        : <span className="notice-disc" role="img" aria-label={tone === 'warn' ? 'Warning' : 'Note'}><Icon size={16} aria-hidden /></span>}
      <span className="notice-text">{text}</span>
    </div>
  )
}

/** A setting changed while the turn ran: one quiet line, not a notice box. */
function SettingLine({ text }: { text: string }) {
  return (
    <div className="setting-line" role="note">
      <SlidersHorizontal size={12} aria-hidden />
      <span>{text}</span>
    </div>
  )
}

/** A setting changed between turns: a quiet rule across the conversation. */
function SettingChange({ text }: { text: string }) {
  return (
    <div className="setting-change" role="note">
      <span className="setting-change-label">
        <SlidersHorizontal size={12} aria-hidden />
        {text}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * A run of steps. One tool call is its own row; anything more folds to one
 * line with one mark for the whole group (done, working while any runs,
 * failed if any failed): the current step while it runs, then what was done
 * and how long it took. Opened, the steps are flat rows indented under the line.
 */
function StepGroup({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const only = steps.length === 1 ? steps[0] : undefined
  if (only?.kind === 'tool') {
    return <div className="tool-group single"><ToolRow tool={only.tool} /></div>
  }

  const tools = steps.flatMap(step => (step.kind === 'tool' ? [step.tool] : []))
  const running = tools.some(tool => tool.status === 'running')
  const failed = tools.filter(needsAttention).length
  // While steps run, the folded line names the current one, like a status bar.
  const current = live ? [...tools].reverse().find(tool => tool.status === 'running') : undefined
  const step = current ? presentTool(current) : undefined
  const duration = running ? undefined : stepsDuration(steps)
  const title = step ? step.verb : tools.length ? summarizeSteps(tools) : thoughtTitle(duration)
  const count = `${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`
  const label = step
    ? `${step.verb}${step.target ? ` ${step.target}` : ''}${tools.length > 1 ? `, ${count}` : ''}, Running`
    : `${title}${failed ? `, ${failed} failed` : ''}${running ? ', Running' : ''}`
  const mark = running ? 'working' : failed ? 'failed' : 'done'

  return (
    <div className={`tool-group${open ? ' open' : ''}${current ? ' is-live' : ''}`}>
      <button type="button" className="tool-group-head step-line" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={label}
        title={step?.target ? `${step.verb} ${step.fullTarget ?? step.target}` : undefined}>
        <PenMark kind={mark} size={16} />
        <span className={`tool-group-title${current ? ' shimmer' : ''}`}>{title}</span>
        {/* A long command shrinks to an ellipsis instead of pushing the line wider. */}
        {step?.target && <span className="tool-target">{step.target}</span>}
        {step && tools.length > 1 && <span className="tool-group-summary">· {count}</span>}
        <StepTail failed={failed} total={tools.length} duration={duration} />
        <ChevronRight size={14} className="chevron" aria-hidden />
      </button>
      {open && (
        <div className="tool-group-list">
          {steps.map(item => item.kind === 'tool'
            ? <ToolRow key={item.id} tool={item.tool} />
            : <Thought key={item.id} text={item.text} streaming={false} {...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {})} />)}
        </div>
      )}
    </div>
  )
}

/** One line of what a failure said, for the right edge of its row. */
function failureReason(tool: ToolView): string {
  return (tool.error ?? 'Failed').split('\n').find(line => line.trim())?.trim() ?? 'Failed'
}

/**
 * One step: its mark, the verb in a column, the target in mono and, when it
 * failed in a way a person must act on, the reason at the right in --danger.
 * Opening it turns the row sunken and shows the full input and output inside.
 */
function ToolRow({ tool }: { tool: ToolView }) {
  const [open, setOpen] = useState<boolean | undefined>(undefined)
  const expanded = open ?? (tool.name === 'run_code' && tool.status === 'running')
  const { verb, target, fullTarget } = presentTool(tool)
  const children = tool.children ?? []
  const running = children.filter(child => child.status === 'running').length
  const failed = children.filter(needsAttention).length
  const completed = children.filter(child => child.status !== 'running').length
  const attention = needsAttention(tool)
  // A model-facing error looks like any finished call; its detail still shows the message.
  const status = tool.status === 'error' && !attention ? 'note' : tool.status
  const mark = tool.status === 'running' ? 'working' : attention ? 'failed' : 'done'
  return (
    <div className={`tool-row status-${status}${expanded ? ' open' : ''}`}>
      <button type="button" className="tool-row-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}
        title={target ? `${verb} ${fullTarget ?? target}` : undefined} aria-label={`${verb}${target ? ` ${target}` : ''}${children.length ? `, ${children.length} tool calls, ${completed} done, ${running} running, ${failed} failed` : ''}${tool.status === 'running' ? ', Running' : attention ? ', Failed' : status === 'note' ? ', Returned an error to the agent' : ''}`}>
        <PenMark kind={mark} size={14} />
        <span className="tool-verb">{verb}</span>
        {target && <span className="tool-target">{target}</span>}
        {children.length ? <span className="tool-group-summary">{children.length} tool {children.length === 1 ? 'call' : 'calls'} · {completed} done{running ? ` · ${running} running` : ''}{failed ? ` · ${failed} failed` : ''}</span> : null}
        <span className="tool-meta">
          {attention && !expanded
            ? <span className="tool-reason">{failureReason(tool)}</span>
            : !attention && tool.status !== 'running' && tool.durationMs !== undefined && <span className="tool-duration">{formatDuration(tool.durationMs)}</span>}
        </span>
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

const SUBAGENT_STATUS: Record<SubagentView['status'], { label: string; mark: PenKind }> = {
  starting: { label: 'Starting', mark: 'working' },
  running: { label: 'Running', mark: 'working' },
  ready: { label: 'Finished', mark: 'done' },
  failed: { label: 'Failed', mark: 'failed' },
}

/** A subagent's report: a result card led by its own avatar, its state as a mark and a word, and its last reply. */
function SubagentCard({ agent, onOpen }: { agent: SubagentView; onOpen?: ((id: string, label: string) => void) | undefined }) {
  const status = SUBAGENT_STATUS[agent.status]
  const latest = agent.replies.at(-1)
  return (
    <div className="result-card subagent-card">
      <div className="result-head">
        <AgentAvatar
          id={agent.id ?? agent.callId ?? agent.label}
          size={24}
          live={agent.status === 'running' || agent.status === 'starting'}
        />
        <div className="result-titles">
          <div className="result-title subagent-label">{agent.label}</div>
          <div className="result-meta">
            <PenMark kind={status.mark} size={14} />
            <span>{agent.mode === 'fork' ? 'Forked subagent' : 'Subagent'} · {status.label}</span>
          </div>
        </div>
        {agent.id && onOpen && (
          <button type="button" className="result-action" aria-label={`Open transcript of ${agent.label}`} onClick={() => onOpen(agent.id!, agent.label)}>
            Open <ChevronRight size={14} aria-hidden />
          </button>
        )}
      </div>
      {agent.task && agent.task !== agent.label && <p className="subagent-task">{agent.task}</p>}
      {agent.error && <Notice tone="error" text={agent.error} />}
      {latest && (
        <div className="subagent-reply">
          <Markdown text={latest.length > 1200 ? `${latest.slice(0, 1200)}…` : latest} />
        </div>
      )}
    </div>
  )
}

/** Files this turn changed: a result card (done mark, a title, the line counts) over a sunken list of paths. */
function EditedFiles({ files, onOpen }: { files: Array<{ path: string; additions?: number; deletions?: number }>; onOpen?: ((path: string) => void) | undefined }) {
  const { show, menu } = useFileMenu()
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const counted = files.some(file => file.additions !== undefined || file.deletions !== undefined)
  const first = files[0]
  return (
    <div className="result-card files-card">
      {menu}
      <div className="result-head">
        <PenMark kind="done" size={24} />
        <div className="result-titles">
          <div className="result-title">{files.length === 1 ? '1 file changed' : `${files.length} files changed`}</div>
          {counted && <div className="result-meta"><span className="diff-add">+{additions}</span> <span className="diff-del">−{deletions}</span></div>}
        </div>
        {onOpen && first && (
          <button type="button" className="result-action" aria-label="Review changes" onClick={() => onOpen(first.path)}>
            Review <ChevronRight size={14} aria-hidden />
          </button>
        )}
      </div>
      <ul className="files-list result-preview">
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
                ? <button type="button" className="files-row" title={`Show the diff of ${file.path}`} onClick={() => onOpen(file.path)} onContextMenu={event => show(event, file.path)}>{body}</button>
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
          <ChevronRight size={12} className={`chevron${open ? ' rotated' : ''}`} />
        </span>
        <span className="compaction-line" />
      </button>
      {open && summary && <div className="compaction-summary"><Markdown text={summary} /></div>}
    </div>
  )
}
