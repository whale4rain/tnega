import { completionObserver, notifyDesktopWaiting } from '../lib/desktop-completion'
import {
  ArrowDown,
  Check,
  ChevronDown,
  CircleDashed,
  GitBranch,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Shrink,
  ShieldQuestion,
  Target,
  Trash2,
  X,
  PanelLeft,
  Code2,
  Bug,
  FlaskConical,
  Telescope,
  Lightbulb,
  PenLine,
  Languages,
  FileSpreadsheet,
  FileText,
  Presentation,
  Table2,
  PanelRight,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, streamRun } from '../lib/api'
import { errorText, folderName } from '../lib/hooks'
import { confirmDialog } from '../lib/dialogs'
import { applyStream, beginRun, formatTokens, fromEvents, type Entry } from '../lib/timeline'
import type {
  AgentType,
  ConfigSnapshot,
  ContextUsage,
  GoalState,
  PlanItem,
  PlanPayload,
  SessionDetail,
  SessionEvent,
  SessionMetrics,
  SessionSummary,
  SlashCommand,
  StreamEvent,
  ImageAttachment,
} from '../lib/types'
import { CLIENT_COMMANDS, mergeCommands, parseCommand } from '../lib/completion'
import { Composer, SessionControls, type RunSettings } from './Composer'
import type { ArgumentSuggestion } from './PromptBox'
import { Menu } from './Menu'
import { Timeline } from './Timeline'
import { QuestionPanel } from './QuestionPanel'
import { BackgroundJobs } from './BackgroundJobs'

export interface Approval {
  id: string
  tool: string
  input: string
}

export function Conversation({
  workspace,
  sessionId,
  config,
  draftSettings,
  onDraftSettingsChange,
  onSessionCreated,
  onSessionsChanged,
  onSessionDeleted,
  onOpenSettings,
  onConfigSaved,
  onOpenSubagent,
  onOpenFile,
  onOpenChange,
  onToggleWorkbench,
  workbenchOpen = false,
  changeCount,
  onBrowserActivity,
  sidebarOpen,
  onToggleSidebar,
}: {
  workspace: string
  sessionId: string | undefined
  config: ConfigSnapshot | undefined
  draftSettings: RunSettings
  onDraftSettingsChange: (patch: Partial<RunSettings>) => void
  onSessionCreated: (summary: SessionSummary) => void
  onSessionsChanged: () => void
  onSessionDeleted: (id: string) => void
  onOpenSettings: () => void
  onConfigSaved?: (config: ConfigSnapshot) => void
  onOpenSubagent: (id: string, label: string) => void
  onOpenFile: (path: string) => void
  /** Show one changed file in the Workbench's Changes view. */
  onOpenChange?: (path: string) => void
  /** Show or hide the Workbench (files, changes, terminal, browser). */
  onToggleWorkbench?: () => void
  workbenchOpen?: boolean
  /** Files changed since the last commit, shown on the Workbench button. */
  changeCount?: number | undefined
  /** The agent started a browser tool: show the browser. */
  onBrowserActivity?: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
}) {
  const [summary, setSummary] = useState<SessionSummary | undefined>()
  const [entries, setEntries] = useState<readonly Entry[]>([])
  const [context, setContext] = useState<ContextUsage | undefined>()
  const [metrics, setMetrics] = useState<SessionMetrics | undefined>()
  const [plan, setPlan] = useState<PlanPayload | undefined>()
  const [goal, setGoal] = useState<GoalState | null>(null)
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [remoteRunning, setRemoteRunning] = useState(false)
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [commandNotice, setCommandNotice] = useState<string>()
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [resumeVersion, setResumeVersion] = useState(0)
  const pendingResume = useRef<string | undefined>(undefined)

  /** Session id that a local stream is currently writing into. */
  const streamingFor = useRef<string | undefined>(undefined)
  const abort = useRef<AbortController | undefined>(undefined)
  const queue = useRef<StreamEvent[]>([])
  const frame = useRef<number | undefined>(undefined)

  // --- loading ------------------------------------------------------------

  const applyDetail = useCallback((detail: SessionDetail) => {
    setSummary(detail.summary)
    setEntries(fromEvents(detail.events))
    setContext(detail.context)
    setMetrics(detail.metrics)
    setPlan(latestPlan(detail.events))
    setRemoteRunning(detail.running && streamingFor.current !== detail.summary.id)
  }, [])

  const reload = useCallback(async (id: string) => {
    const detail = await api.session(workspace, id)
    applyDetail(detail)
    if (detail.summary.mode === 'goal') {
      api.goal(workspace, id).then(result => setGoal(result.goal), () => setGoal(null))
    } else {
      setGoal(null)
    }
    return detail
  }, [workspace, applyDetail])

  useEffect(() => {
    setError(undefined)
    setCommandNotice(undefined)
    setApprovals([])
    if (pendingResume.current !== sessionId) pendingResume.current = undefined
    if (!sessionId) {
      setSummary(undefined)
      setEntries([])
      setContext(undefined)
      setMetrics(undefined)
      setPlan(undefined)
      setGoal(null)
      setRemoteRunning(false)
      return
    }
    // The session was just created by our own send; the live stream owns it.
    if (streamingFor.current === sessionId) return
    let cancelled = false
    setLoading(true)
    api.session(workspace, sessionId)
      .then(detail => {
        if (cancelled) return
        applyDetail(detail)
        if (detail.summary.mode === 'goal') api.goal(workspace, sessionId).then(r => !cancelled && setGoal(r.goal), () => {})
        else setGoal(null)
      })
      .catch(reason => !cancelled && setError(errorText(reason)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [workspace, sessionId, applyDetail])

  // Poll while a run started elsewhere (another tab, the CLI) is still going.
  useEffect(() => {
    if (!remoteRunning || !sessionId) return
    const timer = setInterval(() => {
      reload(sessionId).then(detail => {
        if (!detail.running) onSessionsChanged()
      }, () => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [remoteRunning, sessionId, reload, onSessionsChanged])

  const agentType = summary?.agentType ?? draftSettings.agentType
  useEffect(() => {
    if (!sessionId || agentType !== 'coding') {
      setCommands([])
      return
    }
    let cancelled = false
    api.slashCommands(workspace, sessionId).then(r => !cancelled && setCommands(r.commands), () => {})
    return () => {
      cancelled = true
    }
  }, [workspace, sessionId, agentType])

  // --- settings -----------------------------------------------------------

  const settings: RunSettings = summary
    ? {
        agentType: summary.agentType ?? 'general',
        mode: summary.mode ?? 'auto',
        permission: summary.permission ?? 'read-only',
        approvalMode: summary.approvalMode ?? config?.config.approvalReview?.defaultMode ?? 'manual',
        model: summary.model,
        reasoningEffort: summary.reasoningEffort ?? 'default',
      }
    : draftSettings

  // Client commands work everywhere; coding sessions add the agent's own (skills, MCP).
  const allCommands = useMemo(() => mergeCommands(commands), [commands])
  const models = config?.models
  const completeArgument = useCallback(async (name: string, query: string): Promise<ArgumentSuggestion[]> => {
    const needle = query.toLowerCase()
    if (name === '/codemode') return [
      { value: 'on', label: 'on', detail: 'Enable CodeMode (PTC)' },
      { value: 'off', label: 'off', detail: 'Disable CodeMode' },
    ].filter(item => item.value.startsWith(needle))
    if (name === '/model') {
      return (models ?? [])
        .filter(model => !needle || model.id.toLowerCase().includes(needle) || (model.name ?? '').toLowerCase().includes(needle))
        .map(model => ({ value: model.id, label: model.name || model.id, detail: model.id }))
    }
    if (!sessionId) return []
    const { candidates } = await api.slashCandidates(workspace, sessionId, name)
    return candidates
      .filter(candidate => !needle || candidate.label.toLowerCase().includes(needle))
      .map(candidate => ({ value: candidate.args.join(' '), label: candidate.label, ...(candidate.detail ? { detail: candidate.detail } : {}) }))
  }, [models, sessionId, workspace])
  const searchFiles = useCallback(async (query: string) => (await api.searchFiles(workspace, query)).files, [workspace])

  const changeSettings = async (patch: Partial<RunSettings>) => {
    if (!summary) {
      onDraftSettingsChange(patch)
      return
    }
    // Persist agent type / permission choices as defaults for new sessions too.
    onDraftSettingsChange({
      ...(patch.agentType ? { agentType: patch.agentType } : {}),
      ...(patch.permission ? { permission: patch.permission } : {}),
      ...(patch.approvalMode ? { approvalMode: patch.approvalMode } : {}),
    })
    try {
      const { model, ...rest } = patch
      const body = { ...rest, ...(model ? { model } : {}) }
      if (!Object.keys(body).length) return
      const result = await api.patchSession(workspace, summary.id, body)
      setSummary(result.summary)
      if (patch.mode === 'goal') api.goal(workspace, summary.id).then(r => setGoal(r.goal), () => {})
      if (patch.mode && patch.mode !== 'goal') setGoal(null)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  // --- running ------------------------------------------------------------

  const flush = useCallback(() => {
    frame.current = undefined
    const events = queue.current
    if (!events.length) return
    queue.current = []
    setEntries(current => events.reduce(applyStream, current))
  }, [])

  const onBrowserActivityRef = useRef(onBrowserActivity)
  onBrowserActivityRef.current = onBrowserActivity
  const onStreamEvent = useCallback((event: StreamEvent) => {
    switch (event.type) {
      case 'approval/request':
        notifyDesktopWaiting(event.id)
        setApprovals(list => [...list, { id: event.id, tool: event.tool, input: event.input }])
        return
      case 'plan/start':
        setPlan({ items: [], status: 'pending' })
        return
      case 'plan/items':
      case 'plan/done':
        setPlan(event.plan)
        return
      case 'plan/item':
        setPlan(current => current && {
          ...current,
          items: current.items.map(item => item.id === event.item.id ? event.item : item),
        })
        break
      case 'tool/start':
        if (event.call.name.startsWith('browser_')) onBrowserActivityRef.current?.()
        break
      default:
        break
    }
    queue.current.push(event)
    frame.current ??= requestAnimationFrame(flush)
  }, [flush])

  useEffect(() => () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    abort.current?.abort()
  }, [])

  const run = useCallback(async (id: string, prompt: string, base: readonly Entry[], resumeQueued = false, images: readonly ImageAttachment[] = []) => {
    const controller = new AbortController()
    const notifyCompletion = completionObserver(controller.signal)
    abort.current = controller
    streamingFor.current = id
    setRunning(true)
    setError(undefined)
    setEntries(resumeQueued ? base : beginRun(base, prompt, Date.now(), images))
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await streamRun(workspace, id, prompt, event => {
            notifyCompletion(event)
            onStreamEvent(event)
          }, controller.signal, resumeQueued, images)
          break
        } catch (reason) {
          // A previous run can take a moment to release the session.
          if (reason instanceof ApiError && reason.status === 409 && attempt < 10 && !controller.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 400))
            continue
          }
          throw reason
        }
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorText(reason))
    } finally {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
      flush()
      streamingFor.current = undefined
      abort.current = undefined
      setApprovals([])
      await reload(id).catch(() => {})
      setRunning(false)
      onSessionsChanged()
    }
  }, [workspace, onStreamEvent, flush, reload, onSessionsChanged])

  useEffect(() => {
    if (running || remoteRunning || streamingFor.current || pendingResume.current !== sessionId || !sessionId) return
    pendingResume.current = undefined
    void run(sessionId, '', entries, true)
  }, [running, remoteRunning, sessionId, resumeVersion, entries, run])

  /** Runs a command the UI handles itself; returns undefined when `text` is not one. */
  const runClientCommand = async (text: string): Promise<boolean | undefined> => {
    const parsed = parseCommand(text)
    const spec = parsed && CLIENT_COMMANDS.find(command => command.name === parsed.name)
    if (!parsed || !spec) return undefined
    const { name, rest } = parsed
    if (name === '/codemode') {
      const option = rest.trim().toLowerCase()
      if (option && option !== 'on' && option !== 'off') {
        setError('Use /codemode on or /codemode off.')
        return false
      }
      try {
        setBusy('Saving CodeMode…')
        const saved = await api.saveConfig({ codeMode: option !== 'off' })
        onConfigSaved?.(saved)
        setCommandNotice(saved.config.codeMode ? 'CodeMode enabled (PTC).' : 'CodeMode disabled.')
        return true
      } catch (reason) {
        setError(errorText(reason))
        return false
      } finally { setBusy(undefined) }
    }
    if (name === '/plan' || name === '/goal' || name === '/auto') {
      const mode = name === '/plan' ? 'plan' : name === '/goal' ? 'goal' : 'auto'
      await changeSettings({ mode })
      // "/plan add a chart" switches mode and sends the request in one go.
      return rest && mode !== 'auto' ? sendPrompt(rest, { ...settings, mode }) : true
    }
    if (name === '/model') {
      const needle = rest.toLowerCase()
      const model = (models ?? []).find(each => each.id.toLowerCase() === needle || (each.name ?? '').toLowerCase() === needle)
      if (!model) {
        setError(rest ? `No model called "${rest}". Type /model and a space to pick one.` : 'Type /model and a space to pick a model.')
        return false
      }
      await changeSettings({ model: model.id })
      return true
    }
    if (name === '/compact') {
      if (!sessionId) {
        setError('There is nothing to compact yet.')
        return false
      }
      await compact()
      return true
    }
    if (name === '/rename') {
      if (!sessionId || !rest) {
        setError(sessionId ? 'Give the new title after /rename.' : 'Start the conversation before renaming it.')
        return false
      }
      await rename(rest)
      return true
    }
    return undefined
  }

  const send = async (text: string, images: ImageAttachment[] = []): Promise<boolean> => {
    if (running) return false
    setError(undefined)
    if (!images.length) {
      const handled = await runClientCommand(text)
      if (handled !== undefined) return handled
    }
    return sendPrompt(text, settings, images)
  }

  const sendPrompt = async (text: string, settings: RunSettings, images: ImageAttachment[] = []): Promise<boolean> => {
    let id = sessionId
    try {
      if (!id) {
        setBusy('Starting session…')
        const created = (await api.createSession(workspace, { agentType: settings.agentType, mode: settings.mode })).session
        const patch = {
          approvalMode: settings.approvalMode ?? 'manual',
          ...(settings.permission !== 'read-only' ? { permission: settings.permission } : {}),
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.reasoningEffort !== 'default' ? { reasoningEffort: settings.reasoningEffort } : {}),
        }
        const session = Object.keys(patch).length ? (await api.patchSession(workspace, created.id, patch)).summary : created
        id = session.id
        streamingFor.current = id
        setSummary(session)
        onSessionCreated(session)
      }
      const slash = parseCommand(text)
      if (slash && !images.length && settings.agentType === 'coding' && allCommands.some(command => command.source === 'server' && command.name === slash.name)) {
        setBusy(`Running ${slash.name}…`)
        await api.runSlash(workspace, id, slash.name, slash.rest ? slash.rest.split(/\s+/) : [])
        await reload(id)
        onSessionsChanged()
        return true
      }
    } catch (reason) {
      setError(errorText(reason))
      streamingFor.current = undefined
      return false
    } finally {
      setBusy(undefined)
    }
    void run(id, text, sessionId ? entries : [], false, images)
    return true
  }

  const stop = async () => {
    if (!sessionId && !streamingFor.current) return
    const id = streamingFor.current ?? sessionId!
    const controller = abort.current
    try {
      await api.stop(workspace, id)
    } catch {
      // Falling back to disconnecting is enough to cancel the run.
    }
    setTimeout(() => controller?.abort(), 2500)
    if (remoteRunning) void reload(id)
  }

  const resend = async (entryId: string, text: string) => {
    if (!sessionId || running) return
    try {
      setBusy('Rewinding…')
      await api.truncate(workspace, sessionId, entryId)
      const detail = await reload(sessionId)
      setBusy(undefined)
      void run(sessionId, text, fromEvents(detail.events))
    } catch (reason) {
      setBusy(undefined)
      setError(errorText(reason))
    }
  }

  const fork = async (messageId?: string) => {
    if (!sessionId) return
    try {
      const { session } = await api.forkSession(workspace, sessionId, messageId)
      onSessionCreated(session)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const compact = async () => {
    if (!sessionId) return
    try {
      setBusy('Compacting context…')
      await api.compact(workspace, sessionId)
      await reload(sessionId)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const rename = async (title: string) => {
    if (!sessionId || !title.trim()) return
    try {
      const result = await api.patchSession(workspace, sessionId, { title: title.trim() })
      setSummary(result.summary)
      onSessionsChanged()
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const remove = async () => {
    if (!sessionId) return
    if (!await confirmDialog({
      title: 'Delete session?',
      message: `“${summary?.title || 'This session'}” will be deleted. This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })) return
    try {
      await api.deleteSession(workspace, sessionId)
      onSessionDeleted(sessionId)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const answer = async (approval: Approval, allow: boolean) => {
    const id = streamingFor.current ?? sessionId
    if (!id) return
    setApprovals(list => list.filter(item => item.id !== approval.id))
    try {
      await api.approve(workspace, id, approval.id, allow)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  // --- scrolling ----------------------------------------------------------

  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)
  useEffect(() => {
    pinned.current = true
    setShowJump(false)
  }, [sessionId])
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [entries, approvals, plan])
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinned.current = atBottom
    setShowJump(!atBottom)
  }
  const jump = () => {
    const el = scroller.current
    if (!el) return
    pinned.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // --- render -------------------------------------------------------------

  const live = running || remoteRunning
  const apiKeyMissing = config !== undefined && !config.apiKeySet && !(config.models.some(model => model.apiKeySet))
  const empty = !loading && entries.length === 0
  const title = summary?.title || (sessionId ? 'Untitled session' : 'New session')

  const disabledReason = apiKeyMissing
    ? <>No model API key is configured. <button type="button" className="link-button inline" onClick={onOpenSettings}>Open settings</button></>
    : busy

  return (
    <main className="conversation">
      <header className="conv-header">
        {!sidebarOpen && (
          <button type="button" className="icon-button" onClick={onToggleSidebar} aria-label="Show sidebar" title="Show sidebar (Ctrl+B)">
            <PanelLeft size={17} />
          </button>
        )}
        <div className="conv-title-wrap">
          <div className="conv-title-row">
            {summary ? <EditableTitle value={title} onSave={rename} /> : <h1 className="conv-title">{title}</h1>}
          </div>
          <div className="conv-subtitle">
            <span className="conv-workspace" title={workspace}>{folderName(workspace)}</span>
            {summary?.parentSessionId && <span className="conv-tag"><GitBranch size={11} /> fork</span>}
            {goal && <GoalPill goal={goal} />}
          </div>
        </div>
        <div className="conv-header-actions">
          <div className="header-group">
            <SessionControls settings={settings} onSettingsChange={patch => void changeSettings(patch)} locked={live || Boolean(busy)} />
          </div>
          <div className="header-group header-tools">
          {sessionId && <BackgroundJobs key={`${workspace}:${sessionId}`} workspace={workspace} sessionId={sessionId} />}
          {context && context.limit > 0 && <ContextMeter context={context} metrics={metrics} />}
          {onToggleWorkbench && (
            <button
              type="button"
              className={`icon-button small header-icon${workbenchOpen ? ' active' : ''}`}
              onClick={onToggleWorkbench}
              aria-label={workbenchOpen ? 'Hide workbench' : `Show workbench${changeCount ? ` (${changeCount} changed files)` : ''}`}
              aria-pressed={workbenchOpen}
              title={changeCount ? `Workbench · ${changeCount} changed ${changeCount === 1 ? 'file' : 'files'} (Ctrl+J)` : 'Workbench (Ctrl+J)'}
            >
              <PanelRight size={15} />
              {changeCount !== undefined && changeCount > 0 && <span className="count-badge live" aria-hidden>{changeCount > 99 ? '99+' : changeCount}</span>}
            </button>
          )}
          {summary && (
            <Menu
              label="Session actions"
              align="end"
              className="icon-button small header-icon"
              trigger={<MoreHorizontal size={15} />}
              items={[
                { key: 'fork', label: 'Fork entire session', icon: <GitBranch size={14} />, onSelect: () => void fork(), disabled: live },
                { key: 'compact', label: 'Compact context', icon: <Shrink size={14} />, onSelect: () => void compact(), disabled: live || entries.length === 0 },
                'separator',
                { key: 'delete', label: 'Delete session', icon: <Trash2 size={14} />, danger: true, onSelect: () => void remove(), disabled: live },
              ]}
            />
          )}
          </div>
        </div>
      </header>

      <div className="conv-scroll" ref={scroller} onScroll={onScroll}>
        <div className="conv-column">
          {loading && entries.length === 0 && <TimelineSkeleton />}
          {busy === 'Compacting context…' && <div className="notice notice-info" role="status">Compacting context…</div>}
          {empty && (
            <EmptyState
              workspace={workspace}
              agentType={settings.agentType}
              onPick={prompt => void send(prompt)}
              disabled={Boolean(disabledReason)}
            />
          )}
          <Timeline
            entries={entries}
            running={live}
            actions={{
              onEdit: resend,
              onRetry: resend,
              onFork: messageId => void fork(messageId),
              onOpenSubagent,
              onOpenFile,
              ...(onOpenChange ? { onOpenChange } : {}),
            }}
            agent={{ id: summary?.id ?? streamingFor.current ?? 'draft', role: 'coordinator' }}
            sky={{
              waiting: approvals.length > 0,
              ...(context && context.limit > 0 ? { contextRatio: context.ratio } : {}),
            }}
          />
          {remoteRunning && !running && (
            <div className="notice notice-info remote-run">
              <CircleDashed size={14} className="spin-slow" />
              <span>This session is running elsewhere. Updates appear automatically.</span>
            </div>
          )}
        </div>
      </div>

      <div className="conv-dock">
        <div className="conv-column">
          {showJump && (
            <button type="button" className="jump-button" onClick={jump} aria-label="Jump to latest">
              <ArrowDown size={15} />
            </button>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button type="button" className="icon-button tiny" aria-label="Dismiss" onClick={() => setError(undefined)}><X size={14} /></button>
            </div>
          )}
          {commandNotice && <div className="notice notice-info" role="status">{commandNotice}</div>}
          {approvals.map(approval => (
            <ApprovalCard key={approval.id} approval={approval} onAnswer={allow => void answer(approval, allow)} />
          ))}
          {sessionId && <QuestionPanel key={`${workspace}:${sessionId}`} workspace={workspace} sessionId={sessionId} running={live} onResumeQueued={() => { pendingResume.current = sessionId; setResumeVersion(version => version + 1) }} />}
          {plan && (plan.items.length > 0 || plan.status === 'pending') && <PlanPanel plan={plan} />}
          <Composer
            settings={settings}
            onSettingsChange={patch => void changeSettings(patch)}
            models={config?.models ?? []}
            defaultModelId={config?.effective.modelId}
            commands={allCommands}
            completeArgument={completeArgument}
            searchFiles={searchFiles}
            running={live}
            locked={live || Boolean(busy)}
            disabledReason={disabledReason}
            onSubmit={send}
            onStop={() => void stop()}
            placeholder={sessionId ? 'Reply… (/ for commands, @ for files)' : PLACEHOLDERS[settings.agentType]}
            autoFocusKey={sessionId ?? 'draft'}
          />
        </div>
      </div>
    </main>
  )
}

function latestPlan(events: readonly SessionEvent[]): PlanPayload | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'plan') return event.payload
  }
  return undefined
}

// ---------------------------------------------------------------------------

function EditableTitle({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  if (!editing) {
    return (
      <button type="button" className="conv-title editable" onClick={() => { setDraft(value); setEditing(true) }} title="Rename">
        <span>{value}</span>
        <Pencil size={13} className="edit-hint" />
      </button>
    )
  }
  const commit = () => {
    setEditing(false)
    if (draft.trim() && draft.trim() !== value) onSave(draft)
  }
  return (
    <input
      className="conv-title-input"
      value={draft}
      autoFocus
      aria-label="Session title"
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setEditing(false)
      }}
    />
  )
}

function ContextMeter({ context, metrics }: { context: ContextUsage; metrics: SessionMetrics | undefined }) {
  const ratio = Math.min(1, Math.max(0, context.ratio))
  const tone = ratio > 0.85 ? 'danger' : ratio > 0.65 ? 'warn' : 'ok'
  const r = 6
  const c = 2 * Math.PI * r
  const percent = Math.round(ratio * 100)
  return (
    <div className={`context-meter tone-${tone}`} tabIndex={0} aria-label={`Context ${percent}% used`}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r={r} className="ring-track" />
        <circle cx="8" cy="8" r={r} className={`ring-fill tone-${tone}`} strokeDasharray={`${c * ratio} ${c}`} transform="rotate(-90 8 8)" />
      </svg>
      <div className="context-pop" role="tooltip">
        <div className="context-pop-row"><span>Context</span><strong>{percent}% · {formatTokens(context.tokens)} / {formatTokens(context.limit)}</strong></div>
        {metrics && metrics.responses > 0 && (
          <>
            <div className="context-pop-row"><span>Input tokens</span><strong>{formatTokens(metrics.promptTokens)}</strong></div>
            <div className="context-pop-row"><span>Output tokens</span><strong>{formatTokens(metrics.completionTokens)}</strong></div>
            {metrics.cacheHitRate !== undefined && <div className="context-pop-row"><span>Cache hit rate</span><strong>{Math.round(metrics.cacheHitRate * 100)}%</strong></div>}
            {metrics.tokensPerSecond !== undefined && <div className="context-pop-row"><span>Speed</span><strong>{Math.round(metrics.tokensPerSecond)} tok/s</strong></div>}
          </>
        )}
        <div className="context-pop-note">{context.source === 'provider' ? 'Reported by the model provider' : 'Estimated'}</div>
      </div>
    </div>
  )
}

function GoalPill({ goal }: { goal: GoalState }) {
  return (
    <span className={`conv-tag goal-${goal.status}`} title={goal.objective}>
      <Target size={11} /> Goal {goal.status} · round {goal.rounds}/{goal.maxRounds}
    </span>
  )
}

export function ApprovalCard({ approval, onAnswer }: { approval: Approval; onAnswer: (allow: boolean) => void }) {
  return (
    <div className="approval-card" role="alertdialog" aria-label="Permission request">
      <div className="approval-head">
        <ShieldQuestion size={16} />
        <span>The agent wants to use <strong>{approval.tool}</strong></span>
      </div>
      {approval.input && <pre className="approval-input">{approvalText(approval.input)}</pre>}
      {escalation(approval.input) && (
        <p className="approval-escalation">
          <strong>Runs outside the sandbox</strong>, with your full access{escalation(approval.input)?.justification ? `: ${escalation(approval.input)?.justification}` : '.'}
        </p>
      )}
      <div className="approval-actions">
        <span className="muted small">{escalation(approval.input) ? 'Asks to leave the sandbox for this one call' : 'Outside the current permission level'}</span>
        <button type="button" className="button ghost small" onClick={() => onAnswer(false)}>Deny</button>
        <button type="button" className="button primary small" onClick={() => onAnswer(true)}>Allow once</button>
      </div>
    </div>
  )
}

/** Whether a request asks to run outside the sandbox, and why. */
function escalation(input: string): { justification?: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object' || Reflect.get(parsed, 'escalate') !== true) return undefined
    const justification: unknown = Reflect.get(parsed, 'justification')
    return typeof justification === 'string' && justification.trim() ? { justification: justification.trim() } : {}
  } catch {
    return undefined
  }
}

/** Show a shell command as `$ cmd`, other JSON inputs pretty-printed. */
function approvalText(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input)
    if (parsed && typeof parsed === 'object') {
      const command = (parsed as { command?: unknown }).command
      return typeof command === 'string' ? `$ ${command}` : JSON.stringify(parsed, null, 2)
    }
  } catch {
    // Plain text input.
  }
  return input
}

function PlanPanel({ plan }: { plan: PlanPayload }) {
  const [open, setOpen] = useState(true)
  const done = plan.items.filter(item => item.status === 'done').length
  return (
    <div className={`plan-panel${open ? ' open' : ''}`}>
      <button type="button" className="plan-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <ListChecks size={15} />
        <span className="plan-title">{plan.summary || 'Plan'}</span>
        <span className="plan-count">{plan.items.length ? `${done}/${plan.items.length}` : 'Drafting…'}</span>
        <ChevronDown size={14} className="chevron" />
      </button>
      {open && plan.items.length > 0 && (
        <ol className="plan-items">
          {plan.items.map(item => <PlanRow key={item.id} item={item} />)}
        </ol>
      )}
    </div>
  )
}

function PlanRow({ item }: { item: PlanItem }) {
  return (
    <li className={`plan-item status-${item.status}`}>
      <span className="plan-check">
        {item.status === 'done' ? <Check size={11} strokeWidth={3} /> : item.status === 'failed' ? <X size={11} strokeWidth={3} /> : null}
      </span>
      <span>
        {item.title}
        {item.detail && <span className="plan-detail">{item.detail}</span>}
      </span>
    </li>
  )
}

function TimelineSkeleton() {
  return (
    <div className="skeleton" aria-label="Loading">
      <div className="skeleton-line right w40" />
      <div className="skeleton-line w90" />
      <div className="skeleton-line w75" />
      <div className="skeleton-line w60" />
    </div>
  )
}

const CODING_STARTERS = [
  { icon: Telescope, title: 'Map the codebase', prompt: 'Give me a tour of this codebase: the main modules, how they fit together, and where to start reading.' },
  { icon: Bug, title: 'Hunt a bug', prompt: 'Look for likely bugs or edge cases that are not handled in this project, and explain the most important ones.' },
  { icon: FlaskConical, title: 'Strengthen tests', prompt: 'Find the parts of this project with the weakest test coverage and propose focused tests for them.' },
  { icon: Code2, title: 'Review recent work', prompt: 'Review the most recent changes in this workspace and point out anything risky or unclear.' },
]

const WORK_STARTERS = [
  { icon: FileSpreadsheet, title: 'Summarize data', prompt: 'Find the CSV or Excel files in this workspace and build a summary workbook with totals by category, using formulas.' },
  { icon: FileText, title: 'Write a report', prompt: 'Read the documents in this workspace and write a concise report as a Word document.' },
  { icon: Presentation, title: 'Build a deck', prompt: 'Turn the main findings in this workspace into a short slide deck of five to seven slides.' },
  { icon: Table2, title: 'Tidy a table', prompt: 'Find messy tabular data in this workspace, clean it up, and save a tidy Excel workbook next to it.' },
]

const GENERAL_STARTERS = [
  { icon: Telescope, title: 'Explore this folder', prompt: 'Look around this workspace and summarize what is in it.' },
  { icon: PenLine, title: 'Draft a README', prompt: 'Draft a friendly README for this folder based on what it contains.' },
  { icon: Lightbulb, title: 'Brainstorm', prompt: 'Suggest five practical improvements to the contents of this workspace, most valuable first.' },
  { icon: Languages, title: 'Explain a concept', prompt: 'Explain how an AI agent uses tools, step by step, with a small concrete example.' },
]

const STARTERS: Record<AgentType, typeof GENERAL_STARTERS> = { coding: CODING_STARTERS, work: WORK_STARTERS, general: GENERAL_STARTERS }
const ROLE: Record<AgentType, string> = { coding: 'a coding agent', work: 'a work assistant', general: 'a general assistant' }
const PLACEHOLDERS: Record<AgentType, string> = {
  coding: 'Describe a change, a bug, or a question about the code…',
  work: 'Describe the spreadsheet, document or deck you need…',
  general: 'Ask anything…',
}

function EmptyState({ workspace, agentType, onPick, disabled }: { workspace: string; agentType: AgentType; onPick: (prompt: string) => void; disabled: boolean }) {
  const starters = STARTERS[agentType]
  const hour = new Date().getHours()
  const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  return (
    <div className="empty-state">
      <span className="brand-mark large" aria-hidden />
      <h2>{greeting}. What are we building?</h2>
      <p>
        Working in <span className="mono-chip">{folderName(workspace)}</span>
        {` as ${ROLE[agentType]}.`}
      </p>
      <div className="starter-grid">
        {starters.map(starter => (
          <button
            key={starter.title}
            type="button"
            className="starter"
            disabled={disabled}
            title={starter.prompt}
            onClick={() => onPick(starter.prompt)}
          >
            <starter.icon size={16} />
            <span className="starter-title">{starter.title}</span>
            <span className="starter-prompt">{starter.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
