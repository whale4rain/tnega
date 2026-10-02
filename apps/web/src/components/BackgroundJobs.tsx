import { ListTodo, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type BackgroundJob } from '../lib/api'
import { errorText, useDismiss } from '../lib/hooks'

const STATUS: Record<BackgroundJob['status'], string> = {
  running: 'Running', stopping: 'Stopping…', completed: 'Completed', failed: 'Failed', killed: 'Stopped',
}

export function BackgroundJobs({ workspace, sessionId }: { workspace: string; sessionId: string }) {
  const [jobs, setJobs] = useState<BackgroundJob[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [output, setOutput] = useState<{ id: string; text: string }>()
  const root = useRef<HTMLDivElement>(null)
  const controller = useRef<AbortController | undefined>(undefined)
  useDismiss(open, root, () => setOpen(false))

  useEffect(() => {
    const scope = new AbortController()
    controller.current = scope
    setJobs([])
    setOpen(false)
    setOutput(undefined)
    setError(undefined)
    setPending(undefined)
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await api.jobs(workspace, sessionId, scope.signal)
        if (!scope.signal.aborted) { setJobs(result.jobs); setError(undefined) }
      } catch (reason) {
        if (!scope.signal.aborted) setError(errorText(reason))
      } finally {
        if (!scope.signal.aborted) timer = setTimeout(() => void poll(), 1500)
      }
    }
    void poll()
    return () => { scope.abort(); clearTimeout(timer) }
  }, [workspace, sessionId])

  const act = async (job: BackgroundJob, stop: boolean) => {
    const signal = controller.current?.signal
    setPending(job.id)
    setError(undefined)
    try {
      if (stop) {
        const result = await api.stopJob(workspace, sessionId, job.id, signal)
        if (!signal?.aborted) setJobs(list => list.map(item => item.id === job.id ? result.job : item))
      } else {
        const result = await api.jobOutput(workspace, sessionId, job.id, signal)
        if (!signal?.aborted) {
          setJobs(list => list.map(item => item.id === job.id ? result.job : item))
          setOutput({ id: job.id, text: result.output ?? result.job.detail ?? 'No output yet.' })
        }
      }
    } catch (reason) {
      if (!signal?.aborted) setError(errorText(reason))
    } finally {
      if (!signal?.aborted) setPending(undefined)
    }
  }
  const active = jobs.filter(job => job.status === 'running' || job.status === 'stopping').length
  return (
    <div className="background-jobs menu-root" ref={root}>
      <button
        type="button"
        className="icon-button small header-icon"
        aria-label={`Background tasks (${active} running)`}
        aria-expanded={open}
        title={jobs.length ? `Background tasks · ${active} running of ${jobs.length}` : 'Background tasks'}
        onClick={() => setOpen(value => !value)}
      >
        <ListTodo size={15} />
        {jobs.length > 0 && <span className={`count-badge${active ? ' live' : ''}`} aria-hidden>{active || jobs.length}</span>}
      </button>
      {open && <section className="menu-popover side-bottom align-end background-jobs-popover" aria-label="Background tasks">
        <strong>Background tasks</strong>
        {error && <div role="alert" className="notice notice-error">{error}</div>}
        {!jobs.length && !error && <p className="muted small">No background tasks.</p>}
        {jobs.map(job => <div key={job.id} className="background-job">
          <div className="background-job-head"><strong>{job.label}</strong><span className="muted small">{STATUS[job.status]}</span></div>
          <div className="background-job-actions">
            <button type="button" className="button ghost small" disabled={pending === job.id} aria-label={`Output ${job.label}`} onClick={() => void act(job, false)}>Output</button>
            {job.status === 'running' && <button type="button" className="button ghost small" disabled={pending === job.id} aria-label={`Stop ${job.label}`} onClick={() => void act(job, true)}><Square size={11} />Stop</button>}
          </div>
          {job.detail && <p className="muted small">{job.detail}</p>}
          {output?.id === job.id && <pre className="tool-output">{output.text}</pre>}
        </div>)}
      </section>}
    </div>
  )
}
