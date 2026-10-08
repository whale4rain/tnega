import { ChevronRight, ListTodo, Network, Square, SquareTerminal, Wrench } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, type BackgroundJob, type BackgroundProcess } from '../lib/api'
import { errorText, useDismiss } from '../lib/hooks'
import { navigateBrowser } from '../lib/browser-live'
import { isLive, mergeTasks, shortUrl, taskMeta, type BackgroundTask } from '../lib/background-tasks'

const KIND_ICON = { process: SquareTerminal, subagent: Network, tool: Wrench } as const

/**
 * The session's background work behind one header button: live tasks first,
 * finished ones folded below. A row opens its output in place (following new
 * lines while it runs); servers offer their local URLs as links.
 */
export function BackgroundJobs({ workspace, sessionId, onOpenBrowser }: { workspace: string; sessionId?: string; onOpenBrowser?: (url: string) => void }) {
  const [jobs, setJobs] = useState<BackgroundJob[]>([])
  const [processes, setProcesses] = useState<BackgroundProcess[]>([])
  const [open, setOpen] = useState(false)
  const [showFinished, setShowFinished] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [output, setOutput] = useState<{ key: string; text: string }>()
  const [now, setNow] = useState(() => Date.now())
  const root = useRef<HTMLDivElement>(null)
  const controller = useRef<AbortController | undefined>(undefined)
  const selected = useRef<string | undefined>(undefined)
  selected.current = output?.key
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
        if (!scope.signal.aborted) {
          setJobs(result.jobs)
          setProcesses(processResult.processes ?? [])
          setError(undefined)
          setNow(Date.now())
        }
        // Follow the open output while its task runs.
        const key = selected.current
        const task = key ? mergeTasks(result.jobs, processResult.processes ?? []).find(item => item.key === key) : undefined
        if (task && (isLive(task) || task.source === 'process')) {
          const text = await readOutput(task, scope.signal)
          if (!scope.signal.aborted && selected.current === key) setOutput({ key: task.key, text })
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

  const readOutput = async (task: BackgroundTask, signal?: AbortSignal): Promise<string> => {
    if (task.source === 'process') {
      const detail = await api.processOutput(workspace, task.id, signal)
      return [detail.output, detail.hint ?? detail.note].filter(Boolean).join('\n') || 'No output yet.'
    }
    if (!sessionId) return 'No output yet.'
    const result = await api.jobOutput(workspace, sessionId, task.id, signal)
    if (!signal?.aborted) setJobs(list => list.map(item => item.id === task.id ? result.job : item))
    return result.output || result.job.detail || 'No output yet.'
  }

  const toggleOutput = async (task: BackgroundTask) => {
    if (output?.key === task.key) { setOutput(undefined); return }
    const signal = controller.current?.signal
    setPending(task.key)
    setError(undefined)
    try {
      const text = await readOutput(task, signal)
      if (!signal?.aborted) setOutput({ key: task.key, text })
    } catch (reason) {
      if (!signal?.aborted) setError(errorText(reason))
    } finally {
      if (!signal?.aborted) setPending(undefined)
    }
  }

  const stop = async (task: BackgroundTask) => {
    const signal = controller.current?.signal
    setPending(task.key)
    setError(undefined)
    try {
      if (task.source === 'process') {
        const result = await api.stopProcess(workspace, task.id, signal)
        if (!signal?.aborted) setProcesses(list => list.map(item => item.id === task.id ? result.process : item))
      } else if (sessionId) {
        const result = await api.stopJob(workspace, sessionId, task.id, signal)
        if (!signal?.aborted) setJobs(list => list.map(item => item.id === task.id ? result.job : item))
      }
    } catch (reason) {
      if (!signal?.aborted) setError(errorText(reason))
    } finally {
      if (!signal?.aborted) setPending(undefined)
    }
  }

  const openUrl = (url: string) => {
    if (!onOpenBrowser) return
    setOpen(false)
    onOpenBrowser(url)
    const signal = controller.current?.signal
    void navigateBrowser(url).catch(reason => { if (!signal?.aborted) { setError(errorText(reason)); setOpen(true) } })
  }

  const tasks = mergeTasks(jobs, processes)
  const live = tasks.filter(isLive)
  const finished = tasks.filter(task => !isLive(task))
  const row = (task: BackgroundTask) => (
    <TaskRow
      key={task.key}
      task={task}
      now={now}
      busy={pending === task.key}
      output={output?.key === task.key ? output.text : undefined}
      onToggle={() => void toggleOutput(task)}
      onStop={() => void stop(task)}
      {...(onOpenBrowser ? { onOpenUrl: openUrl } : {})}
    />
  )
  return (
    <div className="background-jobs menu-root" ref={root}>
      <button
        type="button"
        className="icon-button small header-icon"
        aria-label={`Background tasks (${live.length} running)`}
        aria-expanded={open}
        title={tasks.length ? `Background tasks · ${live.length} running of ${tasks.length}` : 'Background tasks'}
        onClick={() => setOpen(value => !value)}
      >
        <ListTodo size={14} />
        {tasks.length > 0 && <span className={`count-badge${live.length ? ' live' : ''}`} aria-hidden>{live.length || tasks.length}</span>}
      </button>
      {open && <section className="menu-popover side-bottom align-end background-jobs-popover" aria-label="Background tasks">
        <header className="bg-tasks-head">
          <strong>Background tasks</strong>
          {tasks.length > 0 && <span className="muted small">{live.length ? `${live.length} running` : 'All finished'}</span>}
        </header>
        {error && <div role="alert" className="notice notice-error">{error}</div>}
        {!tasks.length && !error && <p className="muted small bg-tasks-empty">Long commands, dev servers and delegated agents run here without blocking the conversation.</p>}
        {live.length > 0 && <div className="bg-task-list">{live.map(row)}</div>}
        {finished.length > 0 && (
          <div className="bg-tasks-finished">
            {live.length > 0 && (
              <button type="button" className={`bg-tasks-fold${showFinished ? ' open' : ''}`} aria-expanded={showFinished} onClick={() => setShowFinished(value => !value)}>
                <ChevronRight size={12} className="chevron" />{finished.length} finished
              </button>
            )}
            {(showFinished || live.length === 0) && <div className="bg-task-list">{finished.map(row)}</div>}
          </div>
        )}
      </section>}
    </div>
  )
}

function TaskRow({ task, now, busy, output, onToggle, onStop, onOpenUrl }: {
  task: BackgroundTask
  now: number
  busy: boolean
  output: string | undefined
  onToggle: () => void
  onStop: () => void
  onOpenUrl?: (url: string) => void
}) {
  const Icon = KIND_ICON[task.kind]
  const pre = useRef<HTMLPreElement>(null)
  // Keep a followed output scrolled to its newest line.
  useLayoutEffect(() => {
    const element = pre.current
    if (element) element.scrollTop = element.scrollHeight
  }, [output])
  return (
    <div className={`bg-task status-${task.status}${output !== undefined ? ' open' : ''}`}>
      <div className="bg-task-row">
        <button type="button" className="bg-task-main" aria-label={`Output ${task.label}`} aria-expanded={output !== undefined} disabled={busy} onClick={onToggle}>
          <span className="bg-task-icon" aria-hidden><Icon size={14} /></span>
          <span className="bg-task-text">
            <span className="bg-task-label" title={task.cwd ? `${task.label}\n${task.cwd}` : task.label}>{task.label}</span>
            <span className="bg-task-meta"><i className="bg-task-dot" aria-hidden />{taskMeta(task, now)}</span>
          </span>
        </button>
        {task.status === 'running' && (
          <button type="button" className="icon-button small bg-task-stop" aria-label={`Stop ${task.label}`} title="Stop" disabled={busy} onClick={onStop}>
            <Square size={12} />
          </button>
        )}
      </div>
      {onOpenUrl && task.urls.length > 0 && isLive(task) && (
        <div className="bg-task-links">
          {task.urls.map(url => <button key={url} type="button" className="bg-task-link" aria-label={url} title={`Open ${url} in the browser`} onClick={() => onOpenUrl(url)}>{shortUrl(url)}</button>)}
        </div>
      )}
      {output !== undefined && <pre ref={pre} className="bg-task-output">{output}</pre>}
    </div>
  )
}
