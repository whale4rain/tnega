import {
  Ban,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CirclePlay,
  FileText,
  GitBranch,
  GitPullRequest,
  MessageSquareText,
  RotateCcw,
  Square,
  type LucideIcon,
} from 'lucide-react'
import { useContext, useEffect, useMemo, useState } from 'react'
import { relativeTime } from '../../lib/hooks'
import { projectApi } from '../../lib/project-api'
import {
  board,
  boardFeed,
  checklistProgress,
  formatActive,
  formatCount,
  gitResources,
  projectWeather,
  startOfDay,
  threadActivity,
  threadArtifacts,
  threadLight,
  threadState,
  today,
  LIGHT_LABEL,
  type BoardColumn,
  type BoardEvent,
  type BoardEventKind,
  type LightTone,
  type ProjectState,
} from '../../lib/project-model'
import type { ArtifactFact, ProjectUsage, ResourceFact, ThreadRecord, ThreadState } from '../../lib/project-types'
import type { Weather } from '../../lib/weather'
import { StatusLight } from '../StatusLight'
import { ArtifactContext, ArtifactIcon } from './Artifacts'

/** Lanes with nothing for you to do fold into one line. */
const FOLDED: ReadonlySet<BoardColumn['key']> = new Set(['idle', 'resolved'])

/** The project's forecast as one light, the same colours a thread's light uses. */
const FORECAST_LIGHT: Partial<Record<Weather, LightTone>> = {
  storm: 'failed',
  snow: 'waiting',
  rain: 'working',
  drizzle: 'working',
  clear: 'idle',
}

const FORECAST: Partial<Record<Weather, string>> = {
  storm: 'Something failed',
  snow: 'Waiting on you',
  rain: 'Several threads working',
  drizzle: 'One thread working',
  clear: 'All quiet',
}

/** What an empty lane says in the side-by-side kanban. */
const EMPTY_LANE: Partial<Record<BoardColumn['key'], string>> = {
  needs: 'Nothing waiting on you',
  working: 'No thread running',
  ready: 'No new results',
}

/**
 * The Board: where you go to see how the work stands and collect results.
 * The project's weather and a strip with one segment per thread, then
 * threads by where they stand — needs you, working, ready — with idle and
 * resolved ones folded away, and the last few things threads did. In a wide
 * panel the lanes sit side by side as a kanban; in a narrow one they stack.
 */
export function BoardPanel({
  workspace,
  state,
  seen,
  onOpenThread,
}: {
  workspace: string
  state: ProjectState
  seen: Readonly<Record<string, number>>
  onOpenThread: (id: string) => void
}) {
  const projectId = state.project.id
  const usage = useUsage(workspace, state)
  const columns = useMemo(() => board(state, seen), [state, seen])
  const feed = useMemo(() => boardFeed(state), [state])
  const day = today(state, Date.now(), usage)
  const weather = projectWeather(state)
  const usageOf = (id: string) => usage?.byThread.find(entry => entry.threadId === id)
  const total = columns.reduce((sum, column) => sum + column.threads.length, 0)
  const [error, setError] = useState<string | undefined>()

  const act = (run: () => Promise<unknown>) => {
    setError(undefined)
    run().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  const actions: CardActions = {
    open: onOpenThread,
    resolve: (id, resolved) => act(() => projectApi.resolveThread(workspace, projectId, id, resolved)),
    stop: id => act(() => projectApi.stopThread(workspace, projectId, id)),
  }

  return (
    <div className="wb-view board" aria-label="Board">
      <div className="wb-toolbar">
        <span className="wb-toolbar-title">Board</span>
      </div>
      <div className="wb-card wb-flow wb-scroll board-scroll">
        <header className="board-intro">
          <h2 className="board-title">{state.project.name}</h2>
          <p className="board-forecast-line">
            <StatusLight tone={FORECAST_LIGHT[weather] ?? 'idle'} label={FORECAST[weather] ?? 'All quiet'} />
            <span className="board-forecast">{FORECAST[weather] ?? 'All quiet'}</span>
          </p>
        </header>
        {total > 0 && <Shape state={state} columns={columns} />}
        <p className="board-today" aria-label="Today">
          <span className="board-today-label">Today</span>
          <Stat value={day.started} label="started" />
          <Stat value={day.finished} label="finished" />
          <Stat value={day.artifacts} label={day.artifacts === 1 ? 'output' : 'outputs'} />
          {day.tokens !== undefined && <Stat value={day.tokens} label="tokens" />}
        </p>
        {error && <div className="notice notice-error"><span>{error}</span></div>}
        {total === 0
          ? (
            <div className="board-empty">
              <p>No threads yet.</p>
              <span>Ask for something in the conversation. Each focused task gets its own thread, and it shows up here with its checklist, outputs and what it costs.</span>
            </div>
          )
          : (
            <div className="board-lanes">
              {columns.filter(column => !FOLDED.has(column.key)).map(column => (
                <Lane key={column.key} column={column} state={state} usageOf={usageOf} actions={actions} />
              ))}
            </div>
          )}
        <Folded columns={columns.filter(column => FOLDED.has(column.key))} state={state} usageOf={usageOf} actions={actions} />
        {feed.length > 0 && <Recently feed={feed} onOpenThread={onOpenThread} />}
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return <span className="board-stat"><strong>{formatCount(value)}</strong> {label}</span>
}

/** Left to right: what is behind you, then what is moving, then what needs you. */
const SHAPE_ORDER: ReadonlyArray<BoardColumn['key']> = ['resolved', 'idle', 'ready', 'working', 'needs']

/**
 * The project at a glance: one segment per thread, coloured like its light,
 * with resolved work filling from the left. Hovering a segment names it.
 */
function Shape({ state, columns }: { state: ProjectState; columns: BoardColumn[] }) {
  const lanes = SHAPE_ORDER.flatMap(key => columns.filter(column => column.key === key))
  const total = lanes.reduce((sum, column) => sum + column.threads.length, 0)
  const finished = Object.values(state.threads).filter(thread => thread.id !== state.coordinatorId
    && (threadState(state, thread) === 'done' || threadState(state, thread) === 'resolved')).length
  const summary = lanes.filter(column => column.threads.length > 0).map(column => `${column.threads.length} ${column.label.toLowerCase()}`).join(', ')
  return (
    <div className="board-shape">
      <div className="board-shape-bar" role="img" aria-label={`${total} threads: ${summary}`}>
        {lanes.flatMap(column => column.threads.map(thread => {
          const tone = column.key === 'needs' && threadState(state, thread) === 'failed' ? 'failed' : column.key
          return <span key={thread.id} className={`board-shape-seg seg-${tone}`} title={`${thread.label}: ${column.label}`} />
        }))}
      </div>
      <span className="board-shape-count"><strong>{finished}</strong> of {total} done</span>
    </div>
  )
}

const FEED: Record<BoardEventKind, { verb: string; icon: LucideIcon; tone?: 'warn' | 'danger' | 'success' }> = {
  started: { verb: 'started', icon: CirclePlay },
  reported: { verb: 'reported', icon: MessageSquareText },
  finished: { verb: 'finished', icon: CircleCheck, tone: 'success' },
  asked: { verb: 'asked', icon: CircleHelp, tone: 'warn' },
  blocked: { verb: 'got blocked', icon: Ban, tone: 'warn' },
  failed: { verb: 'failed', icon: CircleAlert, tone: 'danger' },
  output: { verb: 'added', icon: FileText },
  pushed: { verb: 'pushed', icon: GitBranch },
  'pull-request': { verb: 'opened pull request', icon: GitPullRequest },
}

/** The last few things threads did, newest first; each line opens its thread. */
function Recently({ feed, onOpenThread }: { feed: BoardEvent[]; onOpenThread: (id: string) => void }) {
  return (
    <section className="board-feed" aria-label="Recently">
      <h3 className="board-feed-head">Recently</h3>
      <ul className="board-feed-list">
        {feed.map(event => {
          const meta = FEED[event.kind]
          return (
            <li key={event.id}>
              <button type="button" className="board-feed-row" onClick={() => onOpenThread(event.threadId)}>
                <meta.icon size={14} className={`board-feed-icon${meta.tone ? ` tone-${meta.tone}` : ''}`} aria-hidden />
                <span className="board-feed-text">
                  <strong>{event.label}</strong> {meta.verb}{event.text && <span className="board-feed-detail">: {event.text}</span>}
                </span>
                <span className="board-feed-time">{relativeTime(event.at)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

interface CardActions {
  open: (id: string) => void
  resolve: (id: string, resolved: boolean) => void
  stop: (id: string) => void
}

type UsageOf = (id: string) => ProjectUsage['byThread'][number] | undefined

function Lane({ column, state, usageOf, actions }: { column: BoardColumn; state: ProjectState; usageOf: UsageOf; actions: CardActions }) {
  return (
    <section className={`board-lane lane-${column.key}`} aria-label={column.label}>
      <h3 className="board-lane-head" title={column.hint}>
        <span className={`lane-dot lane-dot-${column.key}`} aria-hidden />
        <span>{column.label}</span>
        <span className="count">{column.threads.length}</span>
      </h3>
      <div className="board-lane-cards">
        {column.threads.map(thread => (
          <BoardCard key={thread.id} thread={thread} column={column.key} state={state} usage={usageOf(thread.id)} actions={actions} />
        ))}
        {column.threads.length === 0 && <div className="board-lane-empty">{EMPTY_LANE[column.key] ?? 'Nothing here'}</div>}
      </div>
    </section>
  )
}

/**
 * Threads with nothing pending stay out of the way: idle and resolved ones
 * fold into one line under the lanes and open together.
 */
function Folded({ columns, state, usageOf, actions }: { columns: BoardColumn[]; state: ProjectState; usageOf: UsageOf; actions: CardActions }) {
  const [open, setOpen] = useState(false)
  const shown = columns.filter(column => column.threads.length > 0)
  if (shown.length === 0) return null
  return (
    <section className={`board-resolved${open ? ' open' : ''}`}>
      <button type="button" className="board-resolved-head" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <ChevronRight size={12} className="chevron" />
        {shown.map((column, index) => (
          <span key={column.key} title={column.hint}>
            {index > 0 && <span className="sep" aria-hidden>·</span>}
            {column.label} <span className="count">{column.threads.length}</span>
          </span>
        ))}
      </button>
      {open && (
        <div className="board-lane-cards">
          {shown.flatMap(column => column.threads.map(thread => (
            <BoardCard key={thread.id} thread={thread} column={column.key} state={state} usage={usageOf(thread.id)} actions={actions} />
          )))}
        </div>
      )}
    </section>
  )
}

/** The verb before a card's time: what the thread last did. */
const WHEN: Record<ThreadState, string> = {
  waiting: 'Asked',
  blocked: 'Blocked',
  failed: 'Failed',
  working: 'Updated',
  done: 'Reported',
  idle: 'Updated',
  resolved: 'Resolved',
}

/** Outputs shown on a card before the rest fold into "+N". */
const CARD_OUTPUTS = 3

function BoardCard({
  thread,
  column,
  state,
  usage,
  actions,
}: {
  thread: ThreadRecord
  column: BoardColumn['key']
  state: ProjectState
  usage: ProjectUsage['byThread'][number] | undefined
  actions: CardActions
}) {
  const openArtifact = useContext(ArtifactContext)
  // The Ready lane holds results you have not opened: their light is green.
  const light = column === 'ready' ? 'ready' : threadLight(state, thread)
  const activity = threadActivity(state, thread)
  const tokens = usage ? usage.promptTokens + usage.completionTokens : undefined
  const outputs = cardOutputs(state, thread.id)
  const hidden = outputs.length - CARD_OUTPUTS
  return (
    <div className={`board-card col-${column}`}>
      <StatusLight tone={light} label={LIGHT_LABEL[light]} />
      <div className="board-card-body">
        {/* The title is the card's one button; it stretches over the whole card. */}
        <button type="button" className="board-card-open" onClick={() => actions.open(thread.id)} title={thread.goal}>
          {thread.label}
        </button>
        {activity && <span className="board-card-activity">{activity}</span>}
        <Steps thread={thread} />
        {outputs.length > 0 && (
          <span className="board-card-outputs">
            {outputs.slice(0, CARD_OUTPUTS).map(output => output.kind === 'artifact'
              ? (
                <button key={output.artifact.id} type="button" className="board-chip board-output" title={`Open ${output.artifact.data.title}`}
                  onClick={() => openArtifact ? openArtifact(output.artifact) : actions.open(thread.id)}>
                  <ArtifactIcon mediaType={output.artifact.data.mediaType} size={12} />
                  <span className="board-output-name">{output.artifact.data.title}</span>
                </button>
              )
              : <GitChip key={output.resource.id} resource={output.resource} />)}
            {hidden > 0 && (
              <button type="button" className="board-chip board-output" title="Open the thread to see every output" onClick={() => actions.open(thread.id)}>
                +{hidden}
              </button>
            )}
          </span>
        )}
        <span className="board-card-foot">
          <span>{WHEN[threadState(state, thread)]} {relativeTime(thread.updatedAt)}</span>
          {usage?.activeMs ? <span title="Time spent working">{formatActive(usage.activeMs)} active</span> : null}
          {tokens ? <span title="Tokens used">{formatCount(tokens)} tokens</span> : null}
        </span>
      </div>
      <span className="board-card-actions">
        {column === 'working' && (
          <button type="button" className="icon-button tiny" aria-label="Stop" title="Stop this thread" onClick={() => actions.stop(thread.id)}>
            <Square size={12} fill="currentColor" />
          </button>
        )}
        {column === 'resolved'
          ? (
            <button type="button" className="icon-button tiny" aria-label="Reopen" title="Reopen" onClick={() => actions.resolve(thread.id, false)}>
              <RotateCcw size={12} />
            </button>
          )
          : column !== 'working' && (
            <button type="button" className="icon-button tiny" aria-label="Resolve" title="Mark resolved: you took the result" onClick={() => actions.resolve(thread.id, true)}>
              <CheckCheck size={14} />
            </button>
          )}
      </span>
    </div>
  )
}

/**
 * A thread's checklist as one segment per step: done steps filled, the step
 * it is on breathing, the rest empty. Long checklists fall back to one bar.
 */
function Steps({ thread }: { thread: ThreadRecord }) {
  const progress = checklistProgress(thread)
  const items = thread.checklist ?? []
  if (!progress) return null
  const label = `${progress.done} of ${progress.total} steps done`
  return (
    <span className="board-progress" role="img" aria-label={label} title={label}>
      {items.length <= MAX_SEGMENTS
        ? (
          <span className="board-steps" aria-hidden>
            {items.map((item, index) => <span key={index} className={`board-step step-${item.status}`} title={item.title} />)}
          </span>
        )
        : <span className="board-progress-bar" aria-hidden><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></span>}
      <span className="board-progress-count" aria-hidden>{progress.done}/{progress.total}</span>
    </span>
  )
}

const MAX_SEGMENTS = 12

type CardOutput =
  | { kind: 'artifact'; artifact: ArtifactFact; at: number }
  | { kind: 'git'; resource: ResourceFact; at: number }

/** What a thread made — outputs, pushes and pull requests — newest first. */
function cardOutputs(state: ProjectState, threadId: string): CardOutput[] {
  return [
    ...threadArtifacts(state, threadId).map((artifact): CardOutput => ({ kind: 'artifact', artifact, at: artifact.createdAt })),
    ...gitResources(state, threadId).map((resource): CardOutput => ({ kind: 'git', resource, at: resource.updatedAt })),
  ].sort((a, b) => b.at - a.at)
}

/** A push or pull request as a chip; it opens on the web when there is a page. */
function GitChip({ resource }: { resource: ResourceFact }) {
  const git = resource.data.git
  if (!git) return null
  const pr = git.kind === 'pull-request'
  const Icon = pr ? GitPullRequest : GitBranch
  const name = pr && git.number !== undefined ? `PR #${git.number}` : git.branch ?? resource.data.title
  const failed = git.status === 'rejected' || git.status === 'failed'
  const body = <><Icon size={12} aria-hidden /><span className="board-output-name">{name}</span></>
  const className = `board-chip board-output${failed ? ' tone-danger' : ''}`
  return /^https?:\/\//i.test(resource.data.uri)
    ? <a className={className} href={resource.data.uri} target="_blank" rel="noreferrer noopener" title={`${resource.data.title}: open in the browser`}>{body}</a>
    : <span className={className} title={resource.data.title}>{body}</span>
}

/** Usage refreshes when a thread starts or settles, not on every streamed token. */
function useUsage(workspace: string, state: ProjectState): ProjectUsage | undefined {
  const [usage, setUsage] = useState<ProjectUsage | undefined>()
  const projectId = state.project.id
  const key = Object.values(state.threads).map(thread => `${thread.id}:${thread.state}`).sort().join('|')
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      projectApi.usage(workspace, projectId, startOfDay(Date.now())).then(
        next => { if (!cancelled) setUsage(next) },
        () => undefined,
      )
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [workspace, projectId, key])
  return usage
}
