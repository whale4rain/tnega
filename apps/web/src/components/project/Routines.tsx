import { CalendarClock, Pause, Play, Plus, Trash2, Zap } from 'lucide-react'
import { useState } from 'react'
import { confirmDialog } from '../../lib/dialogs'
import { errorText, relativeTime } from '../../lib/hooks'
import { projectApi } from '../../lib/project-api'
import type { ProjectState } from '../../lib/project-model'
import type { RoutineFact, RoutineSchedule } from '../../lib/project-types'
import { Dialog } from '../Dialog'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case 'daily': return `Every day at ${schedule.time}`
    case 'weekdays': return `Weekdays at ${schedule.time}`
    case 'weekly': return `Every ${WEEKDAYS[schedule.weekday] ?? 'week'} at ${schedule.time}`
    case 'interval': return schedule.minutes % 60 === 0
      ? `Every ${schedule.minutes === 60 ? 'hour' : `${schedule.minutes / 60} hours`}`
      : `Every ${schedule.minutes} minutes`
  }
}

/** "in 3h", "in 12m": when the next run is, from now. */
export function untilTime(at: number, now = Date.now()): string {
  const minutes = Math.round((at - now) / 60_000)
  if (minutes <= 0) return 'due now'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * Routines: recurring work this project owns. Each run goes to the routine's
 * own thread, so its results show up there and on the Board.
 */
export function RoutinesPanel({ workspace, state, onOpenThread }: { workspace: string; state: ProjectState; onOpenThread: (id: string) => void }) {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const projectId = state.project.id
  const routines = [...state.routines].sort((a, b) => Number(b.data.enabled) - Number(a.data.enabled) || a.data.nextRunAt - b.data.nextRunAt)

  const act = (run: () => Promise<unknown>) => {
    setError(undefined)
    run().catch(reason => setError(errorText(reason)))
  }

  return (
    <div className="wb-view" aria-label="Routines">
      <div className="wb-toolbar">
        <span className="wb-toolbar-title">Routines</span>
        <button type="button" className="button secondary small" onClick={() => setCreating(true)}><Plus size={12} /> New routine</button>
      </div>
      <div className="wb-card wb-scroll routines">
        {error && <div className="notice notice-error"><span>{error}</span></div>}
        {routines.length === 0 && (
          <div className="board-empty">
            <CalendarClock size={18} />
            <p>No routines yet.</p>
            <span>Put recurring work on a schedule here, or ask in the conversation: “every weekday at 9, summarise new issues”. Each run goes to its own thread.</span>
          </div>
        )}
        {routines.map(routine => (
          <RoutineRow
            key={routine.id}
            routine={routine}
            threadLabel={routine.data.threadId ? state.threads[routine.data.threadId]?.label : undefined}
            onOpenThread={onOpenThread}
            onToggle={() => act(() => projectApi.updateRoutine(workspace, projectId, routine.id, { enabled: !routine.data.enabled }))}
            onRun={() => act(() => projectApi.runRoutine(workspace, projectId, routine.id))}
            onDelete={() => act(async () => {
              if (!await confirmDialog({ title: `Delete “${routine.data.title}”?`, message: 'Its thread and past results stay.', confirmLabel: 'Delete', danger: true })) return
              await projectApi.updateRoutine(workspace, projectId, routine.id, { deleted: true })
            })}
          />
        ))}
        <p className="routines-note">Routines run while Tnega is running.</p>
      </div>
      {creating && <NewRoutineDialog workspace={workspace} projectId={projectId} onClose={() => setCreating(false)} />}
    </div>
  )
}

function RoutineRow({
  routine,
  threadLabel,
  onOpenThread,
  onToggle,
  onRun,
  onDelete,
}: {
  routine: RoutineFact
  threadLabel: string | undefined
  onOpenThread: (id: string) => void
  onToggle: () => void
  onRun: () => void
  onDelete: () => void
}) {
  const data = routine.data
  return (
    <div className={`routine-row${data.enabled ? '' : ' paused'}`}>
      <span className="routine-icon"><CalendarClock size={14} /></span>
      <div className="routine-main">
        <div className="routine-title">{data.title}</div>
        <div className="routine-schedule">
          {describeSchedule(data.schedule)}
          {' · '}
          {data.enabled ? `next ${untilTime(data.nextRunAt)}` : 'paused'}
          {data.lastRunAt !== undefined && ` · last ran ${relativeTime(data.lastRunAt)}`}
        </div>
        {data.lastError && <div className="routine-error">Could not start: {data.lastError}</div>}
        {data.threadId && (
          <button type="button" className="link-button routine-thread" onClick={() => onOpenThread(data.threadId!)}>
            {threadLabel ?? 'Open its thread'}
          </button>
        )}
      </div>
      <div className="routine-actions">
        <button type="button" className="icon-button tiny" aria-label="Run now" title="Run now" onClick={onRun}><Zap size={12} /></button>
        <button type="button" className="icon-button tiny" aria-label={data.enabled ? 'Pause' : 'Resume'} title={data.enabled ? 'Pause' : 'Resume'} onClick={onToggle}>
          {data.enabled ? <Pause size={12} /> : <Play size={12} />}
        </button>
        <button type="button" className="icon-button tiny" aria-label="Delete" title="Delete" onClick={onDelete}><Trash2 size={12} /></button>
      </div>
    </div>
  )
}

type Kind = RoutineSchedule['kind']

function NewRoutineDialog({ workspace, projectId, onClose }: { workspace: string; projectId: string; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<Kind>('weekdays')
  const [time, setTime] = useState('09:00')
  const [weekday, setWeekday] = useState(1)
  const [minutes, setMinutes] = useState(60)
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const schedule: RoutineSchedule = kind === 'interval'
    ? { kind, minutes }
    : kind === 'weekly' ? { kind, time, weekday } : { kind, time }

  const save = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await projectApi.createRoutine(workspace, projectId, { title: title.trim(), prompt: prompt.trim(), schedule })
      onClose()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="New routine"
      description="Each run sends this brief to the routine's own thread."
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="button primary" disabled={busy || !title.trim() || !prompt.trim()} onClick={() => void save()}>Create</button>
        </>
      )}
    >
      <div className="form-stack">
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={title} onChange={event => setTitle(event.target.value)} placeholder="Morning digest" autoFocus />
        </label>
        <label className="field">
          <span className="field-label">What each run should do</span>
          <textarea className="input" rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Summarise new issues and anything that changed since the last run." />
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-label">When</span>
            <select className="input" value={kind} onChange={event => setKind(event.target.value as Kind)}>
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Every week</option>
              <option value="interval">Every few minutes or hours</option>
            </select>
          </label>
          {kind === 'weekly' && (
            <label className="field">
              <span className="field-label">Day</span>
              <select className="input" value={weekday} onChange={event => setWeekday(Number(event.target.value))}>
                {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
              </select>
            </label>
          )}
          {kind === 'interval'
            ? (
              <label className="field">
                <span className="field-label">Minutes</span>
                <input className="input" type="number" min={5} step={5} value={minutes} onChange={event => setMinutes(Number(event.target.value))} />
              </label>
            )
            : (
              <label className="field">
                <span className="field-label">Time</span>
                <input className="input" type="time" value={time} onChange={event => setTime(event.target.value)} />
              </label>
            )}
        </div>
        {error && <div className="notice notice-error"><span>{error}</span></div>}
      </div>
    </Dialog>
  )
}
