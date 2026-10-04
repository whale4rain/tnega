import { CheckCheck, ChevronRight, RotateCcw, Square } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { relativeTime } from '../../lib/hooks'
import { projectApi } from '../../lib/project-api'
import {
  board,
  checklistProgress,
  formatActive,
  formatCount,
  projectWeather,
  startOfDay,
  threadActivity,
  threadArtifacts,
  threadWeather,
  today,
  type BoardColumn,
  type ProjectState,
} from '../../lib/project-model'
import type { ProjectUsage, ThreadRecord } from '../../lib/project-types'
import type { Weather } from '../../lib/weather'
import { AgentAvatar } from '../AgentAvatar'
import { ARTIFACT_KIND, artifactKind, type ArtifactKind } from './Artifacts'

const FORECAST: Partial<Record<Weather, string>> = {
  storm: 'Something failed',
  snow: 'Waiting on you',
  rain: 'Several threads working',
  drizzle: 'One thread working',
  clear: 'All quiet',
}

/**
 * The Board: where you go to see how the work stands and collect results.
 * A "Today" strip under the project's weather, then threads by where they
 * stand — needs you, working, ready, idle — with resolved ones folded away.
 * In a wide panel the lanes sit side by side as a kanban; in a narrow one
 * they stack.
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
        <span className="board-forecast">{FORECAST[weather]}</span>
      </div>
      <div className="wb-card wb-scroll board-scroll">
        <section className="board-today" aria-label="Today">
          <AgentAvatar id={state.coordinatorId} role="coordinator" size={44} weather={weather} live={weather === 'drizzle' || weather === 'rain'} title={FORECAST[weather]} />
          <div className="board-today-main">
            <div className="board-today-headline">
              <strong>{day.started}</strong> {day.started === 1 ? 'thread' : 'threads'} opened today
            </div>
            <div className="board-today-stats">
              <Stat value={day.finished} label="finished" />
              <Stat value={day.artifacts} label={day.artifacts === 1 ? 'output' : 'outputs'} />
              {day.tokens !== undefined && <Stat value={day.tokens} label="tokens" />}
              <Stat value={columns.find(column => column.key === 'working')!.threads.length} label="live" />
            </div>
          </div>
        </section>
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
              {columns.filter(column => column.key !== 'resolved').map(column => (
                <Lane key={column.key} column={column} state={state} usageOf={usageOf} actions={actions} />
              ))}
            </div>
          )}
        <Resolved column={columns.find(column => column.key === 'resolved')!} state={state} usageOf={usageOf} actions={actions} />
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return <span className="board-stat"><strong>{formatCount(value)}</strong> {label}</span>
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
        <span>{column.label}</span>
        <span className="count">{column.threads.length}</span>
      </h3>
      <div className="board-lane-cards">
        {column.threads.map(thread => (
          <BoardCard key={thread.id} thread={thread} column={column.key} state={state} usage={usageOf(thread.id)} actions={actions} />
        ))}
        {column.threads.length === 0 && <div className="board-lane-empty">—</div>}
      </div>
    </section>
  )
}

function Resolved({ column, state, usageOf, actions }: { column: BoardColumn; state: ProjectState; usageOf: UsageOf; actions: CardActions }) {
  const [open, setOpen] = useState(false)
  if (column.threads.length === 0) return null
  return (
    <section className={`board-resolved${open ? ' open' : ''}`}>
      <button type="button" className="board-resolved-head" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <ChevronRight size={13} className="chevron" />
        <span>Resolved</span>
        <span className="count">{column.threads.length}</span>
      </button>
      {open && (
        <div className="board-lane-cards">
          {column.threads.map(thread => (
            <BoardCard key={thread.id} thread={thread} column="resolved" state={state} usage={usageOf(thread.id)} actions={actions} />
          ))}
        </div>
      )}
    </section>
  )
}

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
  const weather = threadWeather(state, thread)
  const activity = threadActivity(state, thread)
  const progress = checklistProgress(thread)
  const kinds = artifactKinds(state, thread.id)
  const tokens = usage ? usage.promptTokens + usage.completionTokens : undefined
  return (
    <div className={`board-card col-${column}`}>
      <button type="button" className="board-card-open" onClick={() => actions.open(thread.id)} title={thread.goal}>
        <AgentAvatar id={thread.id} size={28} weather={weather === 'clear' ? undefined : weather} live={weather === 'drizzle'} />
        <span className="board-card-body">
          <span className="board-card-title">{thread.label}</span>
          {activity && <span className="board-card-activity">{activity}</span>}
          {progress && (
            <span className="board-progress" aria-label={`${progress.done} of ${progress.total} steps done`}>
              <span className="board-progress-bar"><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></span>
              <span className="board-progress-count">{progress.done}/{progress.total}</span>
            </span>
          )}
          {kinds.length > 0 && (
            <span className="board-card-outputs">
              {kinds.map(([kind, count]) => {
                const meta = ARTIFACT_KIND[kind]
                return <span key={kind} className="board-chip"><meta.icon size={11} aria-hidden />{count > 1 ? `${count} ${meta.plural}` : meta.label}</span>
              })}
            </span>
          )}
          <span className="board-card-foot">
            <span>{relativeTime(thread.updatedAt)}</span>
            {usage?.activeMs ? <span title="Time spent working">{formatActive(usage.activeMs)} active</span> : null}
            {tokens ? <span title="Tokens used">{formatCount(tokens)} tokens</span> : null}
          </span>
        </span>
      </button>
      <span className="board-card-actions">
        {column === 'working' && (
          <button type="button" className="icon-button tiny" aria-label="Stop" title="Stop this thread" onClick={() => actions.stop(thread.id)}>
            <Square size={11} fill="currentColor" />
          </button>
        )}
        {column === 'resolved'
          ? (
            <button type="button" className="icon-button tiny" aria-label="Reopen" title="Reopen" onClick={() => actions.resolve(thread.id, false)}>
              <RotateCcw size={13} />
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

function artifactKinds(state: ProjectState, threadId: string): Array<[ArtifactKind, number]> {
  const counts = new Map<ArtifactKind, number>()
  for (const artifact of threadArtifacts(state, threadId)) {
    const kind = artifactKind(artifact.data.mediaType)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts]
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
