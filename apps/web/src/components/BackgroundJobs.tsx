import { ListTodo, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type BackgroundJob, type BackgroundProcess } from '../lib/api'
import { errorText, useDismiss } from '../lib/hooks'
import { navigateBrowser } from '../lib/browser-live'

const STATUS: Record<BackgroundJob['status'], string> = {
  running: 'Running', stopping: 'Stopping…', completed: 'Completed', failed: 'Failed', killed: 'Stopped',
}

type Task = Pick<BackgroundJob, 'id' | 'label' | 'status' | 'startedAt' | 'detail'> & { source: 'job' | 'process'; urls?: string[]; cwd?: string }

export function BackgroundJobs({ workspace, sessionId, onOpenBrowser }: { workspace: string; sessionId?: string; onOpenBrowser?: (url: string) => void }) {
  const [jobs, setJobs] = useState<BackgroundJob[]>([])
  const [processes, setProcesses] = useState<BackgroundProcess[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [output, setOutput] = useState<{ id: string; text: string }>()
  const root = useRef<HTMLDivElement>(null)
  const controller = useRef<AbortController | undefined>(undefined)
  const selectedOutput = useRef<string | undefined>(undefined)
  selectedOutput.current = output?.id
  useDismiss(open, root, () => setOpen(false))

  useEffect(() => {
    const scope = new AbortController()
    controller.current = scope
    setJobs([])
    setProcesses([])
    setOpen(false)
    setOutput(undefined)
    setError(undefined)
    setPending(undefined)
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const [result, processResult] = await Promise.all([
          sessionId ? api.jobs(workspace, sessionId, scope.signal) : Promise.resolve({ jobs: [] }),
          api.processes(workspace, scope.signal),
        ])
        if (!scope.signal.aborted) { setJobs(result.jobs); setProcesses(processResult.processes ?? []); setError(undefined) }
        const selected = selectedOutput.current
        if (selected?.startsWith('process:')) {
          const detail = await api.processOutput(workspace, selected.slice('process:'.length), scope.signal)
          if (!scope.signal.aborted && selectedOutput.current === selected) setOutput({ id: selected, text: [detail.output, detail.hint ?? detail.note].filter(Boolean).join('\n') || 'No output yet.' })
        }
      } catch (reason) {
        if (!scope.signal.aborted) setError(errorText(reason))
      } finally {
        if (!scope.signal.aborted) timer = setTimeout(() => void poll(), 1500)
      }
    }
    void poll()
    return () => { scope.abort(); clearTimeout(timer) }
  }, [workspace, sessionId])

  const act = async (job: Task, stop: boolean) => {
    const signal = controller.current?.signal
    const key = `${job.source}:${job.id}`
    setPending(key)
    setError(undefined)
    try {
      if (job.source === 'process') {
        if (stop) {
          const result = await api.stopProcess(workspace, job.id, signal)
          if (!signal?.aborted) setProcesses(list => list.map(item => item.id === job.id ? result.process : item))
        } else {
          const result = await api.processOutput(workspace, job.id, signal)
          if (!signal?.aborted) {
            setProcesses(list => list.map(item => item.id === job.id ? result.process : item))
            setOutput({ id: key, text: [result.output, result.hint ?? result.note].filter(Boolean).join('\n') || 'No output yet.' })
          }
        }
      } else if (stop && sessionId) {
        const result = await api.stopJob(workspace, sessionId, job.id, signal)
        if (!signal?.aborted) setJobs(list => list.map(item => item.id === job.id ? result.job : item))
      } else if (sessionId) {
        const result = await api.jobOutput(workspace, sessionId, job.id, signal)
        if (!signal?.aborted) {
          setJobs(list => list.map(item => item.id === job.id ? result.job : item))
          setOutput({ id: key, text: result.output ?? result.job.detail ?? 'No output yet.' })
        }
      }
    } catch (reason) {
      if (!signal?.aborted) setError(errorText(reason))
    } finally {
      if (!signal?.aborted) setPending(undefined)
    }
  }
  const tasks: Task[] = [
    ...jobs.map(job => ({ ...job, source: 'job' as const })),
    ...processes.map(process => ({ ...process, label: process.command, source: 'process' as const,
      ...(typeof process.exitCode === 'number' ? { detail: `Exit code ${process.exitCode}` } : {}) })),
  ]
  const active = tasks.filter(job => job.status === 'running' || job.status === 'stopping').length
  return (
    <div className="background-jobs menu-root" ref={root}>
      <button
        type="button"
        className="icon-button small header-icon"
        aria-label={`Background tasks (${active} running)`}
        aria-expanded={open}
        title={tasks.length ? `Background tasks · ${active} running of ${tasks.length}` : 'Background tasks'}
        onClick={() => setOpen(value => !value)}
      >
        <ListTodo size={15} />
        {tasks.length > 0 && <span className={`count-badge${active ? ' live' : ''}`} aria-hidden>{active || tasks.length}</span>}
      </button>
      {open && <section className="menu-popover side-bottom align-end background-jobs-popover" aria-label="Background tasks">
        <strong>Background tasks</strong>
        {error && <div role="alert" className="notice notice-error">{error}</div>}
        {!tasks.length && !error && <p className="muted small">No background tasks.</p>}
        {tasks.map(job => <div key={`${job.source}:${job.id}`} className="background-job">
          <div className="background-job-head"><strong>{job.label}</strong><span className="muted small">{STATUS[job.status]}</span></div>
          {job.source === 'process' && <p className="muted small" title={job.cwd}>Process · {new Date(job.startedAt).toLocaleTimeString()} · {job.cwd}</p>}
          <div className="background-job-actions">
            <button type="button" className="button ghost small" disabled={pending === `${job.source}:${job.id}`} aria-label={`Output ${job.label}`} onClick={() => void act(job, false)}>Output</button>
            {job.status === 'running' && <button type="button" className="button ghost small" disabled={pending === `${job.source}:${job.id}`} aria-label={`Stop ${job.label}`} onClick={() => void act(job, true)}><Square size={11} />Stop</button>}
            {onOpenBrowser && job.urls?.map(url => <button key={url} type="button" className="button ghost small" onClick={() => {
              setOpen(false)
              onOpenBrowser(url)
              const signal = controller.current?.signal
              void navigateBrowser(url).catch(reason => { if (!signal?.aborted) { setError(errorText(reason)); setOpen(true) } })
            }}>{url}</button>)}
          </div>
          {job.detail && <p className="muted small">{job.detail}</p>}
          {output?.id === `${job.source}:${job.id}` && <pre className="tool-output">{output.text}</pre>}
        </div>)}
      </section>}
    </div>
  )
}
